const mongoose = require('mongoose');
const leadModal = require('../models/leadModal');
const LeadActivity = require('../models/leadActivity');
const Property = require('../models/property');
const User = require('../models/user');
const UserPropertyActivity = require('../models/userPropertyActivity');
const UserSearchHistory = require('../models/userSearchHistory');
const ContactPreferences = require('../models/userContactDetails');
const { uploadToS3 } = require('../utils/s3');
const { logInfo, logError } = require('../utils/logger');

exports.getUserDashboard = async (req, res) => {
    try {
        const userId = req.user.userId;

        // Check if phone is verified
        const user = await User.findById(userId).select('isPhoneVerified').lean();
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        if (!user.isPhoneVerified) {
            return res.status(403).json({
                success: false,
                message: 'Please verify your phone number with OTP to access dashboard',
                requiresOTPVerification: true
            });
        }

        // Optimize: Run all count queries in parallel
        const [totalViewed, totalFavorited, totalVisited] = await Promise.all([
            UserPropertyActivity.countDocuments({ userId, activityType: "viewed" }),
            UserPropertyActivity.countDocuments({ userId, activityType: "favorite" }),
            UserPropertyActivity.countDocuments({ userId, activityType: "visited" })
        ]);

        logInfo('User dashboard data fetched', { userId, totalViewed, totalFavorited, totalVisited });
        res.status(200).json({
            success: true,
            message: "Dashboard data fetched",
            data: {
                totalViewed,
                totalFavorited,
                totalVisited
            }
        });

    } catch (error) {
        logError('Error fetching user dashboard', error, { userId: req.user.userId });
        res.status(500).json({
            success: false,
            message: "Error fetching dashboard",
            error: error.message
        });
    }
};

exports.addViewedProperty = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { propertyId } = req.body;

        const existing = await UserPropertyActivity.findOne({
            userId,
            propertyId,
            activityType: "viewed"
        }).lean();

        if (existing) {
            await UserPropertyActivity.updateOne(
                { _id: existing._id },
                { lastViewedAt: new Date() }
            );
        } else {
            await UserPropertyActivity.create({
                userId,
                propertyId,
                activityType: "viewed",
                lastViewedAt: new Date()
            });
        }

        logInfo('Property view added in dashboard', { userId, propertyId });
        res.json({ success: true, message: "View added successfully" });

    } catch (error) {
        logError('Error adding property view in dashboard', error, { userId, propertyId });
        res.json({ success: false, message: error.message });
    }
};

exports.toggleFavoriteProperty = async (req, res) => {
    try {
        const { propertyId } = req.body;
        const userId = req.user.userId;

        const existing = await UserPropertyActivity.findOne({
            userId,
            propertyId,
            activityType: "favorite"
        }).lean();

        if (existing) {
            await UserPropertyActivity.deleteOne({ _id: existing._id });
            logInfo('Property removed from favorites in dashboard', { userId, propertyId });
            return res.json({
                success: true,
                message: "Removed from favorites"
            });
        }

        await UserPropertyActivity.create({
            userId,
            propertyId,
            activityType: "favorite",
            favoritedAt: new Date()
        });

        logInfo('Property added to favorites in dashboard', { userId, propertyId });
        res.json({ success: true, message: "Added to favorites" });

    } catch (error) {
        logError('Error toggling favorite property in dashboard', error, { userId, propertyId });
        res.json({ success: false, message: error.message });
    }
};

exports.registerVisit = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { propertyId, visitDate, visitTime, source = "origin" } = req.body;

        // Validate property
        const property = await Property.findById(propertyId).populate('relationshipManager');
        if (!property) {
            return res.status(404).json({ success: false, message: "Property not found" });
        }

        // Parse visitDate
        let parsedVisitDate = visitDate ? new Date(visitDate) : null;
        if (visitDate && isNaN(parsedVisitDate.getTime())) {
            return res.status(400).json({ success: false, message: "Invalid visitDate format" });
        }

        // Create or update visit activity - optimize with updateOne
        const existingActivity = await UserPropertyActivity.findOne({
            userId,
            propertyId,
            activityType: "visited"
        }).lean();

        if (existingActivity) {
            const updateData = {
                visitedAt: new Date(),
                visitTime,
                source: source || "origin",
                updatedBy: userId
            };
            // Only update visitDate if provided to prevent overwriting existing values
            if (parsedVisitDate) {
                updateData.visitDate = parsedVisitDate;
            }
            await UserPropertyActivity.updateOne(
                { _id: existingActivity._id },
                updateData
            );
        } else {
            await UserPropertyActivity.create({
                userId,
                propertyId,
                activityType: "visited",
                visitedAt: new Date(),
                visitDate: parsedVisitDate,
                visitTime,
                source: source || "origin",
                updatedBy: userId,
                isStatus: true
            });
        }

        // Helper function to get IP address from request
        const getClientIpAddress = (req) => {
            // Check for IP in various headers (for proxies/load balancers)
            const forwarded = req.headers['x-forwarded-for'];
            if (forwarded) {
                // x-forwarded-for can contain multiple IPs, take the first one
                return forwarded.split(',')[0].trim();
            }

            // Check x-real-ip header
            if (req.headers['x-real-ip']) {
                return req.headers['x-real-ip'];
            }

            // Check req.ip (if express trust proxy is enabled)
            if (req.ip) {
                return req.ip;
            }

            // Fallback to connection remote address
            if (req.connection && req.connection.remoteAddress) {
                return req.connection.remoteAddress;
            }

            // Final fallback
            if (req.socket && req.socket.remoteAddress) {
                return req.socket.remoteAddress;
            }

            return null;
        };

        // Get IP address
        const ipAddress = getClientIpAddress(req);

        // Create lead (minimal fields only)
        await leadModal.create({
            userId,
            propertyId,
            relationshipManagerId: property.relationshipManager?._id,
            rmEmail: property.relationshipManager?.email || "",
            rmPhone: property.relationshipManager?.phone || "",
            isStatus: true,
            source: source || "origin",
            updatedBy: userId,
            ipAddress: ipAddress
        });

        res.json({
            success: true,
            message: "Visit registered & lead created successfully"
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.registerUpdateVisit = async (req, res) => {
    try {
        const { leadId } = req.params;
        const userId = req.user.userId;
        const { visitDate, visitTime, source } = req.body;

        const updated = await leadModal.findByIdAndUpdate(
            leadId,
            { visitDate, visitTime, source, updatedBy: userId },
            { new: true }
        );

        res.json({
            success: true,
            message: "Lead updated successfully",
            data: updated
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};

exports.getSearchHistory = async (req, res) => {
    try {
        const userId = req.user.userId;

        // Get all search history for user, sorted by most recent
        const searches = await UserSearchHistory.find({ userId })
            .sort({ updatedAt: -1, createdAt: -1 })
            .lean()
            .limit(100); // Limit to last 100 searches for performance

        // Helper function to format date label (Today, Yesterday, or date)
        const getDateLabel = (date) => {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);

            const searchDate = new Date(date);
            searchDate.setHours(0, 0, 0, 0);

            if (searchDate.getTime() === today.getTime()) {
                return 'Today';
            } else if (searchDate.getTime() === yesterday.getTime()) {
                return 'Yesterday';
            } else {
                // Format as "DD MMM YYYY" (e.g., "15 Dec 2024")
                return searchDate.toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric'
                });
            }
        };

        // Group searches by date label
        const grouped = {};

        for (const search of searches) {
            // Use updatedAt if available (for duplicate searches), otherwise use createdAt
            const searchDate = search.updatedAt || search.createdAt;
            const dateLabel = getDateLabel(searchDate);

            if (!grouped[dateLabel]) {
                grouped[dateLabel] = [];
            }

            // Format search entry to match UI requirements
            grouped[dateLabel].push({
                _id: search._id,
                searchQuery: search.searchQuery || '',
                location: search.location || '',
                createdAt: search.createdAt,
                updatedAt: search.updatedAt || search.createdAt
            });
        }

        // Convert grouped object to array format for easier frontend handling
        // Sort by date (Today first, then Yesterday, then others by date)
        const sortedGroups = Object.keys(grouped).sort((a, b) => {
            if (a === 'Today') return -1;
            if (b === 'Today') return 1;
            if (a === 'Yesterday') return -1;
            if (b === 'Yesterday') return 1;
            // For other dates, sort descending (newest first)
            return b.localeCompare(a);
        });

        const formattedData = sortedGroups.map(dateLabel => ({
            dateLabel,
            searches: grouped[dateLabel]
        }));

        logInfo('Search history fetched', { userId, searchCount: searches.length, groupCount: sortedGroups.length });
        res.json({
            success: true,
            message: 'Search history fetched',
            data: formattedData
        });
    } catch (error) {
        logError('Error fetching search history', error, { userId: req.user?.userId });
        res.status(500).json({ success: false, message: error.message });
    }
};

// Save Contact Preferences - Only Location, Budget, and Floor
exports.saveContactPreferences = async (req, res) => {
    try {
        const userId = req.user.userId || req.user._id;

        // Only allow these fields for preferences
        const { preferredLocations, budgetMin, budgetMax, floorMin, floorMax } = req.body;

        // Validate preferredLocations (array of objects with name, latitude, longitude)
        if (preferredLocations !== undefined) {
            if (!Array.isArray(preferredLocations)) {
                return res.status(400).json({
                    success: false,
                    message: "preferredLocations must be an array"
                });
            }
            // Validate each location object
            for (let i = 0; i < preferredLocations.length; i++) {
                const loc = preferredLocations[i];
                if (!loc || typeof loc !== 'object') {
                    return res.status(400).json({
                        success: false,
                        message: `preferredLocations[${i}] must be an object with name, latitude, and longitude`
                    });
                }
                if (!loc.name || typeof loc.name !== 'string') {
                    return res.status(400).json({
                        success: false,
                        message: `preferredLocations[${i}].name is required and must be a string`
                    });
                }
                if (loc.latitude !== undefined && (typeof loc.latitude !== 'number' || isNaN(loc.latitude))) {
                    return res.status(400).json({
                        success: false,
                        message: `preferredLocations[${i}].latitude must be a valid number`
                    });
                }
                if (loc.longitude !== undefined && (typeof loc.longitude !== 'number' || isNaN(loc.longitude))) {
                    return res.status(400).json({
                        success: false,
                        message: `preferredLocations[${i}].longitude must be a valid number`
                    });
                }
            }
        }

        // Validate budget range
        if (budgetMin !== undefined && (typeof budgetMin !== 'number' || budgetMin < 0)) {
            return res.status(400).json({
                success: false,
                message: "budgetMin must be a positive number"
            });
        }

        if (budgetMax !== undefined && (typeof budgetMax !== 'number' || budgetMax < 0)) {
            return res.status(400).json({
                success: false,
                message: "budgetMax must be a positive number"
            });
        }

        if (budgetMin !== undefined && budgetMax !== undefined && budgetMin > budgetMax) {
            return res.status(400).json({
                success: false,
                message: "budgetMin cannot be greater than budgetMax"
            });
        }

        // Validate floor range
        if (floorMin !== undefined && (typeof floorMin !== 'number' || floorMin < 0)) {
            return res.status(400).json({
                success: false,
                message: "floorMin must be a positive number"
            });
        }

        if (floorMax !== undefined && (typeof floorMax !== 'number' || floorMax < 0)) {
            return res.status(400).json({
                success: false,
                message: "floorMax must be a positive number"
            });
        }

        if (floorMin !== undefined && floorMax !== undefined && floorMin > floorMax) {
            return res.status(400).json({
                success: false,
                message: "floorMin cannot be greater than floorMax"
            });
        }

        // Build update data object (only include provided fields)
        const updateData = {};
        if (preferredLocations !== undefined) updateData.preferredLocations = preferredLocations;
        if (budgetMin !== undefined) updateData.budgetMin = budgetMin;
        if (budgetMax !== undefined) updateData.budgetMax = budgetMax;
        if (floorMin !== undefined) updateData.floorMin = floorMin;
        if (floorMax !== undefined) updateData.floorMax = floorMax;

        // Find or create preferences
        const existing = await ContactPreferences.findOne({ userId }).lean();

        let result;

        if (existing) {
            // Update existing preferences
            result = await ContactPreferences.findOneAndUpdate(
                { userId },
                updateData,
                { new: true, upsert: false }
            ).lean();
        } else {
            // Create new preferences
            updateData.userId = userId;
            result = await ContactPreferences.create(updateData);
        }

        logInfo('Contact preferences saved', { userId, preferences: updateData });

        return res.status(200).json({
            success: true,
            message: existing ? "Preferences Updated" : "Preferences Saved",
            data: {
                preferredLocations: result.preferredLocations || [],
                budgetMin: result.budgetMin || null,
                budgetMax: result.budgetMax || null,
                floorMin: result.floorMin || null,
                floorMax: result.floorMax || null
            }
        });

    } catch (error) {
        logError('Error saving contact preferences', error, { userId: req.user?.userId || req.user?._id });
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// GET DATA - Get Contact Preferences (Location, Budget, Floor only)
exports.getContactPreferences = async (req, res) => {
    try {
        const userId = req.user.userId || req.user._id;

        const result = await ContactPreferences.findOne({ userId })
            .select('preferredLocations budgetMin budgetMax floorMin floorMax')
            .lean();

        logInfo('Contact preferences fetched', { userId });
        return res.status(200).json({
            success: true,
            data: {
                preferredLocations: result?.preferredLocations || [],
                budgetMin: result?.budgetMin || null,
                budgetMax: result?.budgetMax || null,
                floorMin: result?.floorMin || null,
                floorMax: result?.floorMax || null
            }
        });

    } catch (error) {
        logError('Error fetching contact preferences', error, { userId: req.user?.userId || req.user?._id });
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Viewed Properties
exports.getViewedProperties = async (req, res) => {
    try {
        const userId = req.user.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const total = await UserPropertyActivity.countDocuments({
            userId,
            activityType: "viewed"
        });

        const data = await UserPropertyActivity.find({
            userId,
            activityType: "viewed"
        })
            .populate("propertyId")
            .sort({ lastViewedAt: -1 })
            .skip(skip)
            .limit(limit);

        logInfo('Viewed properties fetched', { userId, total, page, limit });
        res.json({
            success: true,
            message: "Viewed properties fetched",
            data,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        logError('Error fetching viewed properties', error, { userId });
        res.json({ success: false, message: error.message });
    }
};

// Favorited Properties
exports.getFavoritedProperties = async (req, res) => {
    try {
        const userId = req.user.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const total = await UserPropertyActivity.countDocuments({
            userId,
            activityType: "favorite"
        });

        // Optimize query with lean() and select only needed fields
        const data = await UserPropertyActivity.find({
            userId,
            activityType: "favorite"
        })
            .populate("propertyId", 'projectName location developer')
            .select('propertyId favoritedAt')
            .sort({ favoritedAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        logInfo('Favorited properties fetched', { userId, total, page, limit });
        res.json({
            success: true,
            message: "Favorited properties fetched",
            data,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        logError('Error fetching favorited properties', error, { userId });
        res.json({ success: false, message: error.message });
    }
};

// Update User Profile - For all user data updates (except preferences)
exports.updateProfile = async (req, res) => {
    try {
        const userId = req.user.userId || req.user._id;
        const {
            firstName,
            lastName,
            email,
            phoneNumber,
            countryCode,
            pincode,
            city,
            state,
            country
        } = req.body;
        let profileImage = req.body.profileImage;

        // Handle file upload if provided
        if (req.file) {
            profileImage = await uploadToS3(req.file, 'users/profile');
        }

        const updates = {};

        // Update basic fields
        if (firstName !== undefined) updates.firstName = firstName;
        if (lastName !== undefined) updates.lastName = lastName;
        if (email !== undefined) {
            // Check if email already exists for another user
            const existingUser = await User.findOne({ email, _id: { $ne: userId } }).lean();
            if (existingUser) {
                return res.status(400).json({
                    success: false,
                    message: 'Email already exists'
                });
            }
            updates.email = email;
        }
        if (phoneNumber !== undefined) {
            // Validate phone number format
            if (phoneNumber.length !== 10) {
                return res.status(400).json({
                    success: false,
                    message: 'Phone number must be 10 digits'
                });
            }
            updates.phoneNumber = phoneNumber;
        }
        if (countryCode !== undefined) {
            if (!countryCode.startsWith('+')) {
                return res.status(400).json({
                    success: false,
                    message: 'Country code must start with + (e.g., +91)'
                });
            }
            updates.countryCode = countryCode;
        }
        if (profileImage !== undefined) updates.profileImage = profileImage;

        // Update profile fields (pincode, city, state, country)
        if (pincode !== undefined) updates.pincode = pincode;
        if (city !== undefined) updates.city = city;
        if (state !== undefined) updates.state = state;
        if (country !== undefined) updates.country = country;

        // Check if any updates provided
        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update'
            });
        }

        // Update user
        const updatedUser = await User.findByIdAndUpdate(userId, updates, {
            new: true,
            runValidators: true
        }).select('-password').populate('role', 'name permissions').lean();

        if (!updatedUser) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        logInfo('User profile updated', { userId, updatedFields: Object.keys(updates) });

        res.status(200).json({
            success: true,
            message: "Profile updated successfully",
            data: {
                user: {
                    id: updatedUser._id,
                    firstName: updatedUser.firstName,
                    lastName: updatedUser.lastName,
                    name: updatedUser.name,
                    email: updatedUser.email,
                    phoneNumber: updatedUser.phoneNumber,
                    countryCode: updatedUser.countryCode,
                    profileImage: updatedUser.profileImage,
                    pincode: updatedUser.pincode,
                    city: updatedUser.city,
                    state: updatedUser.state,
                    country: updatedUser.country,
                    role: updatedUser.role,
                    createdAt: updatedUser.createdAt,
                    updatedAt: updatedUser.updatedAt
                }
            }
        });

    } catch (error) {
        logError('Error updating user profile', error, { userId: req.user?.userId || req.user?._id });
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Visited Properties - Get from Lead model with visit activities
exports.getVisitedProperties = async (req, res) => {
    try {
        const userId = req.user.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Get leads with visit activities using aggregation
        // First, get all leads for this user that have visit activities
        const leadsWithVisits = await leadModal.aggregate([
            // Match leads for this user
            {
                $match: {
                    userId: new mongoose.Types.ObjectId(userId),
                    isStatus: true,
                    propertyId: { $exists: true, $ne: null }
                }
            },
            // Lookup visit activities
            {
                $lookup: {
                    from: 'leadactivities',
                    let: { leadId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$leadId', '$$leadId'] },
                                        { $eq: ['$activityType', 'visit'] }
                                    ]
                                }
                            }
                        },
                        { $sort: { visitDate: -1, activityDate: -1 } },
                        { $limit: 1 } // Get the latest visit activity
                    ],
                    as: 'visitActivity'
                }
            },
            // Filter only leads that have visit activities
            {
                $match: {
                    'visitActivity.0': { $exists: true }
                }
            },
            // Sort by latest visit date
            {
                $sort: {
                    'visitActivity.visitDate': -1,
                    'visitActivity.activityDate': -1
                }
            }
        ]);

        // Separate upcoming and completed visits
        const upcomingLeads = [];
        const completedLeads = [];

        leadsWithVisits.forEach(lead => {
            const visitActivity = lead.visitActivity[0];
            if (visitActivity && visitActivity.visitDate) {
                const visitDate = new Date(visitActivity.visitDate);
                visitDate.setHours(0, 0, 0, 0);

                if (visitDate >= today) {
                    upcomingLeads.push(lead);
                } else {
                    completedLeads.push(lead);
                }
            } else {
                // If no visitDate, use activityDate
                const activityDate = new Date(visitActivity?.activityDate || lead.createdAt);
                activityDate.setHours(0, 0, 0, 0);

                if (activityDate >= today) {
                    upcomingLeads.push(lead);
                } else {
                    completedLeads.push(lead);
                }
            }
        });

        // Sort upcoming by visit date (ascending - earliest first)
        upcomingLeads.sort((a, b) => {
            const dateA = new Date(a.visitActivity[0]?.visitDate || a.visitActivity[0]?.activityDate || a.createdAt);
            const dateB = new Date(b.visitActivity[0]?.visitDate || b.visitActivity[0]?.activityDate || b.createdAt);
            return dateA - dateB;
        });

        // Sort completed by visit date (descending - latest first)
        completedLeads.sort((a, b) => {
            const dateA = new Date(a.visitActivity[0]?.visitDate || a.visitActivity[0]?.activityDate || a.createdAt);
            const dateB = new Date(b.visitActivity[0]?.visitDate || b.visitActivity[0]?.activityDate || b.createdAt);
            return dateB - dateA;
        });

        // Paginate
        const upcomingTotal = upcomingLeads.length;
        const completedTotal = completedLeads.length;

        const upcomingPaginated = upcomingLeads.slice(skip, skip + limit);
        const completedPaginated = completedLeads.slice(skip, skip + limit);

        // Populate property data for upcoming visits
        const upcomingWithProperties = await Promise.all(
            upcomingPaginated.map(async (lead) => {
                const property = await Property.findById(lead.propertyId)
                    .populate('developer', 'developerName logo')
                    .select('projectName location developer images offerPrice developerPrice discountPercentage')
                    .lean();

                const visitActivity = lead.visitActivity[0];

                return {
                    lead: {
                        _id: lead._id,
                        userId: lead.userId,
                        propertyId: lead.propertyId,
                        relationshipManagerId: lead.relationshipManagerId,
                        rmEmail: lead.rmEmail,
                        rmPhone: lead.rmPhone,
                        visitStatus: lead.visitStatus,
                        status: lead.status,
                        source: lead.source,
                        createdAt: lead.createdAt,
                        updatedAt: lead.updatedAt
                    },
                    visitActivity: {
                        _id: visitActivity._id,
                        activityType: visitActivity.activityType,
                        visitDate: visitActivity.visitDate,
                        visitTime: visitActivity.visitTime,
                        activityDate: visitActivity.activityDate,
                        description: visitActivity.description
                    },
                    property: property ? {
                        _id: property._id,
                        projectName: property.projectName,
                        location: property.location,
                        developer: property.developer,
                        coverImage: property.images?.find(img => img.isCover)?.url || property.images?.[0]?.url || null,
                        offerPrice: property.offerPrice,
                        developerPrice: property.developerPrice,
                        discountPercentage: property.discountPercentage
                    } : null
                };
            })
        );

        // Populate property data for completed visits
        const completedWithProperties = await Promise.all(
            completedPaginated.map(async (lead) => {
                const property = await Property.findById(lead.propertyId)
                    .populate('developer', 'developerName logo')
                    .select('projectName location developer images offerPrice developerPrice discountPercentage')
                    .lean();

                const visitActivity = lead.visitActivity[0];

                return {
                    lead: {
                        _id: lead._id,
                        userId: lead.userId,
                        propertyId: lead.propertyId,
                        relationshipManagerId: lead.relationshipManagerId,
                        rmEmail: lead.rmEmail,
                        rmPhone: lead.rmPhone,
                        visitStatus: lead.visitStatus,
                        status: lead.status,
                        source: lead.source,
                        createdAt: lead.createdAt,
                        updatedAt: lead.updatedAt
                    },
                    visitActivity: {
                        _id: visitActivity._id,
                        activityType: visitActivity.activityType,
                        visitDate: visitActivity.visitDate,
                        visitTime: visitActivity.visitTime,
                        activityDate: visitActivity.activityDate,
                        description: visitActivity.description
                    },
                    property: property ? {
                        _id: property._id,
                        projectName: property.projectName,
                        location: property.location,
                        developer: property.developer,
                        coverImage: property.images?.find(img => img.isCover)?.url || property.images?.[0]?.url || null,
                        offerPrice: property.offerPrice,
                        developerPrice: property.developerPrice,
                        discountPercentage: property.discountPercentage
                    } : null
                };
            })
        );

        logInfo('Visited properties fetched from Lead model', {
            userId,
            upcomingTotal,
            completedTotal,
            page,
            limit
        });

        res.json({
            success: true,
            message: "Visited properties fetched",
            data: {
                upcoming: upcomingWithProperties,
                completed: completedWithProperties
            },
            pagination: {
                upcoming: {
                    total: upcomingTotal,
                    page,
                    limit,
                    totalPages: Math.ceil(upcomingTotal / limit)
                },
                completed: {
                    total: completedTotal,
                    page,
                    limit,
                    totalPages: Math.ceil(completedTotal / limit)
                }
            }
        });

    } catch (error) {
        logError('Error fetching visited properties', error, { userId: req.user.userId });
        res.json({ success: false, message: error.message });
    }
};
