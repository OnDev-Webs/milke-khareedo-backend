const mongoose = require('mongoose');
const leadModal = require('../models/leadModal');
const LeadActivity = require('../models/leadActivity');
const Property = require('../models/property');
const User = require('../models/user');
const UserPropertyActivity = require('../models/userPropertyActivity');
const UserSearchHistory = require('../models/userSearchHistory');
const ContactPreferences = require('../models/userContactDetails');
const Developer = require('../models/developer');
const { uploadToS3 } = require('../utils/s3');
const { logInfo, logError } = require('../utils/logger');

// Helper function to format property images array (cover first, then by order)
const formatPropertyImages = (images) => {
    if (!images || !Array.isArray(images) || images.length === 0) {
        return [];
    }

    // Separate cover image and other images
    const coverImages = images.filter(img => img.isCover === true);
    const otherImages = images.filter(img => !img.isCover || img.isCover === false);

    // Sort cover images (should only be one, but handle multiple)
    coverImages.sort((a, b) => (a.order || 0) - (b.order || 0));

    // Sort other images by order
    otherImages.sort((a, b) => (a.order || 0) - (b.order || 0));

    // Combine: cover first, then others
    const sortedImages = [...coverImages, ...otherImages];

    // Return array of image URLs
    return sortedImages.map(img => {
        // Handle both object format { url, isCover, order } and string format
        if (typeof img === 'string') {
            return img;
        }
        return img.url || img;
    }).filter(Boolean); // Remove any null/undefined values
};

// Helper function to extract prices from configurations (handles both old and new format)
// Price is now stored as Number (in rupees), but we handle legacy string format too
const extractPricesFromConfigurations = (configurations, fallbackPrice = 0) => {
    const prices = [];
    if (!configurations || !Array.isArray(configurations)) return prices;

    const parsePrice = (price) => {
        if (!price) return 0;
        if (typeof price === 'number') return price;
        let priceNum = parseFloat(price.toString().replace(/[₹,\s]/g, '')) || 0;
        const priceStrLower = price.toString().toLowerCase();
        if (priceStrLower.includes('lakh') || priceStrLower.includes('l')) {
            priceNum = priceNum * 100000;
        } else if (priceStrLower.includes('cr') || priceStrLower.includes('crore')) {
            priceNum = priceNum * 10000000;
        }
        return priceNum;
    };

    configurations.forEach(config => {
        if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
            config.subConfigurations.forEach(subConfig => {
                const priceNum = parsePrice(subConfig.price || fallbackPrice);
                if (priceNum > 0) prices.push(priceNum);
            });
        } else {
            const priceNum = parsePrice(config.price || fallbackPrice);
            if (priceNum > 0) prices.push(priceNum);
        }
    });

    return prices;
};

// Helper function to format property data with all required fields
const formatPropertyData = async (property) => {
    // Format property data similar to getTopVisitedProperties
    let developerInfo = null;
    if (property.developer?._id || property.developer?.developerName) {
        developerInfo = { developerName: property.developer.developerName || 'N/A' };
    } else {
        const developerId = property.developer?.toString() || property.developer;
        if (developerId) {
            developerInfo = await Developer.findById(developerId).select('developerName').lean();
        }
    }

    // Helper to parse price (handles both number and string)
    const parsePrice = (price) => {
        if (!price) return 0;
        if (typeof price === 'number') return price;
        let priceNum = parseFloat(price.toString().replace(/[₹,\s]/g, '')) || 0;
        const priceStrLower = price.toString().toLowerCase();
        if (priceStrLower.includes('lakh') || priceStrLower.includes('l')) {
            priceNum = priceNum * 100000;
        } else if (priceStrLower.includes('cr') || priceStrLower.includes('crore')) {
            priceNum = priceNum * 10000000;
        }
        return priceNum;
    };

    const fallbackPrice = parsePrice(property.developerPrice || property.offerPrice || 0);
    const prices = extractPricesFromConfigurations(property.configurations, fallbackPrice);

    const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
    const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

    // Format images array (cover first, then by order)
    const images = formatPropertyImages(property.images);

    // Format lastDayToJoin from possessionDate
    let lastDayToJoin = null;
    if (property.possessionDate) {
        const date = new Date(property.possessionDate);
        lastDayToJoin = date.toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
        });
    }

    // Calculate opening left (available units)
    const openingLeft = (() => {
        let count = 0;
        if (property.configurations && Array.isArray(property.configurations)) {
            property.configurations.forEach(config => {
                if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
                    count += config.subConfigurations.filter(sc => sc.availabilityStatus === 'Available' || sc.availabilityStatus === 'Ready').length;
                } else if (config.availabilityStatus === 'Available' || config.availabilityStatus === 'Ready') {
                    count += 1;
                }
            });
        }
        return count;
    })();

    // Parse prices for discount calculation
    const parsePriceForDiscount = (price) => {
        if (!price) return 0;
        if (typeof price === 'number') return price;
        let priceNum = parseFloat(price.toString().replace(/[₹,\s]/g, '')) || 0;
        const priceStrLower = price.toString().toLowerCase();
        if (priceStrLower.includes('lakh') || priceStrLower.includes('l')) {
            priceNum = priceNum * 100000;
        } else if (priceStrLower.includes('cr') || priceStrLower.includes('crore')) {
            priceNum = priceNum * 10000000;
        }
        return priceNum;
    };

    const devPriceNum = parsePriceForDiscount(property.developerPrice);
    const offerPriceNum = parsePriceForDiscount(property.offerPrice);

    // Calculate discount
    let discountAmount = 0;
    let discountPercentageValue = 0;
    if (property.discountPercentage) {
        discountPercentageValue = parseFloat(property.discountPercentage.replace('%', '')) || 0;
        if (devPriceNum > 0 && discountPercentageValue > 0) {
            discountAmount = (devPriceNum * discountPercentageValue) / 100;
        }
    } else if (devPriceNum > 0 && offerPriceNum > 0 && devPriceNum > offerPriceNum) {
        discountAmount = devPriceNum - offerPriceNum;
        discountPercentageValue = parseFloat(((discountAmount / devPriceNum) * 100).toFixed(2));
    }

    const formatPrice = (amount) => {
        if (!amount || amount === 0) return '₹ 0';
        if (amount >= 10000000) {
            return `₹ ${(amount / 10000000).toFixed(2)} Crore`;
        } else if (amount >= 100000) {
            return `₹ ${(amount / 100000).toFixed(2)} Lakh`;
        } else {
            return `₹ ${amount.toLocaleString('en-IN')}`;
        }
    };

    // Format relationship manager phone
    const rmPhone = property.relationshipManager?.phone || property.relationshipManager?.phoneNumber || null;
    const rmCountryCode = property.relationshipManager?.countryCode || '+91';
    const formattedRmPhone = rmPhone ? `${rmCountryCode} ${rmPhone}` : null;

    // Prepare response data
    return {
        id: property._id,
        projectId: property.projectId,
        projectName: property.projectName,
        location: property.location,
        latitude: property.latitude || null,
        longitude: property.longitude || null,
        images: images,
        lastDayToJoin: lastDayToJoin ? `Last Day to join ${lastDayToJoin}` : null,
        openingLeft: openingLeft,
        developer: developerInfo?.developerName || 'N/A',
        developerPrice: {
            value: devPriceNum,
            formatted: formatPrice(devPriceNum)
        },
        offerPrice: offerPriceNum > 0 ? {
            value: offerPriceNum,
            formatted: formatPrice(offerPriceNum)
        } : null,
        price: devPriceNum > 0 ? formatPrice(devPriceNum) : (offerPriceNum > 0 ? formatPrice(offerPriceNum) : null),
        relationshipManagerPhone: formattedRmPhone,
        discount: discountAmount > 0 && discountPercentageValue > 0 ? {
            amount: discountAmount,
            amountFormatted: formatPrice(discountAmount),
            percentage: discountPercentageValue,
            percentageFormatted: `${discountPercentageValue.toFixed(2)}%`
        } : null
    };
};

exports.getUserDashboard = async (req, res) => {
    try {
        const userId = req.user.userId;

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

        if (!propertyId) {
            return res.status(400).json({ success: false, message: "Property ID is required" });
        }

        // Check if property exists
        const property = await Property.findById(propertyId)
            .populate('developer', 'developerName')
            .populate('relationshipManager', 'name email phone phoneNumber countryCode')
            .select('projectName location latitude longitude configurations images developerPrice offerPrice discountPercentage minGroupMembers projectId possessionStatus developer relationshipManager possessionDate')
            .lean();

        if (!property) {
            return res.status(404).json({ success: false, message: "Property not found" });
        }

        // Update or create view activity
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

        // Format property data using helper function
        const propertyData = await formatPropertyData(property);

        logInfo('Property view added in dashboard', { userId, propertyId });
        res.json({
            success: true,
            message: "View added successfully",
            data: propertyData
        });

    } catch (error) {
        logError('Error adding property view in dashboard', error, { userId: req.user?.userId, propertyId: req.body?.propertyId });
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.toggleFavoriteProperty = async (req, res) => {
    try {
        const { propertyId } = req.body;
        const userId = req.user.userId;

        if (!propertyId) {
            return res.status(400).json({ success: false, message: "Property ID is required" });
        }

        // Check if property exists and fetch with required fields
        const property = await Property.findById(propertyId)
            .populate('developer', 'developerName')
            .populate('relationshipManager', 'name email phone phoneNumber countryCode')
            .select('projectName location latitude longitude configurations images developerPrice offerPrice discountPercentage minGroupMembers projectId possessionStatus developer relationshipManager possessionDate')
            .lean();

        if (!property) {
            return res.status(404).json({ success: false, message: "Property not found" });
        }

        const existing = await UserPropertyActivity.findOne({
            userId,
            propertyId,
            activityType: "favorite"
        }).lean();

        if (existing) {
            await UserPropertyActivity.deleteOne({ _id: existing._id });
            logInfo('Property removed from favorites in dashboard', { userId, propertyId });

            // Format and return property data
            const propertyData = await formatPropertyData(property);
            return res.json({
                success: true,
                message: "Removed from favorites",
                data: propertyData
            });
        }

        await UserPropertyActivity.create({
            userId,
            propertyId,
            activityType: "favorite",
            favoritedAt: new Date()
        });

        logInfo('Property added to favorites in dashboard', { userId, propertyId });

        // Format and return property data
        const propertyData = await formatPropertyData(property);
        res.json({
            success: true,
            message: "Added to favorites",
            data: propertyData
        });

    } catch (error) {
        logError('Error toggling favorite property in dashboard', error, { userId: req.user?.userId, propertyId: req.body?.propertyId });
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.registerVisit = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { propertyId, visitDate, visitTime, source = "origin" } = req.body;

        if (!propertyId) {
            return res.status(400).json({ success: false, message: "Property ID is required" });
        }

        // Check if property exists and fetch with required fields
        const property = await Property.findById(propertyId)
            .populate('developer', 'developerName')
            .populate('relationshipManager', 'name email phone phoneNumber countryCode')
            .select('projectName location latitude longitude configurations images developerPrice offerPrice discountPercentage minGroupMembers projectId possessionStatus developer relationshipManager possessionDate')
            .lean();

        if (!property) {
            return res.status(404).json({ success: false, message: "Property not found" });
        }

        let parsedVisitDate = visitDate ? new Date(visitDate) : null;
        if (visitDate && isNaN(parsedVisitDate.getTime())) {
            return res.status(400).json({ success: false, message: "Invalid visitDate format" });
        }

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

        const getClientIpAddress = (req) => {
            const forwarded = req.headers['x-forwarded-for'];
            if (forwarded) {
                return forwarded.split(',')[0].trim();
            }

            if (req.headers['x-real-ip']) {
                return req.headers['x-real-ip'];
            }

            if (req.ip) {
                return req.ip;
            }

            if (req.connection && req.connection.remoteAddress) {
                return req.connection.remoteAddress;
            }

            if (req.socket && req.socket.remoteAddress) {
                return req.socket.remoteAddress;
            }

            return null;
        };

        const ipAddress = getClientIpAddress(req);

        await leadModal.create({
            userId,
            propertyId,
            relationshipManagerId: property.relationshipManager?._id,
            rmEmail: property.relationshipManager?.email || "",
            rmPhone: property.relationshipManager?.phone || property.relationshipManager?.phoneNumber || "",
            isStatus: true,
            source: source || "origin",
            updatedBy: userId,
            ipAddress: ipAddress
        });

        // Format and return property data
        const propertyData = await formatPropertyData(property);

        res.json({
            success: true,
            message: "Visit registered & lead created successfully",
            data: propertyData
        });

    } catch (error) {
        logError('Error registering visit in dashboard', error, { userId: req.user?.userId, propertyId: req.body?.propertyId });
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

        const searches = await UserSearchHistory.find({ userId })
            .sort({ updatedAt: -1, createdAt: -1 })
            .lean()
            .limit(100);

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
                return searchDate.toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric'
                });
            }
        };

        const grouped = {};

        for (const search of searches) {
            const searchDate = search.updatedAt || search.createdAt;
            const dateLabel = getDateLabel(searchDate);

            if (!grouped[dateLabel]) {
                grouped[dateLabel] = [];
            }

            grouped[dateLabel].push({
                _id: search._id,
                searchQuery: search.searchQuery || '',
                location: search.location || '',
                createdAt: search.createdAt,
                updatedAt: search.updatedAt || search.createdAt
            });
        }

        const sortedGroups = Object.keys(grouped).sort((a, b) => {
            if (a === 'Today') return -1;
            if (b === 'Today') return 1;
            if (a === 'Yesterday') return -1;
            if (b === 'Yesterday') return 1;
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

        const { preferredLocations, budgetMin, budgetMax, floorMin, floorMax } = req.body;

        const budgetMinNum = budgetMin !== undefined ? Number(budgetMin) : undefined;
        const budgetMaxNum = budgetMax !== undefined ? Number(budgetMax) : undefined;
        const floorMinNum = floorMin !== undefined ? Number(floorMin) : undefined;
        const floorMaxNum = floorMax !== undefined ? Number(floorMax) : undefined;

        if (preferredLocations !== undefined) {
            if (!Array.isArray(preferredLocations)) {
                return res.status(400).json({
                    success: false,
                    message: "preferredLocations must be an array"
                });
            }
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

        if (budgetMinNum !== undefined && (isNaN(budgetMinNum) || budgetMinNum < 0)) {
            return res.status(400).json({
                success: false,
                message: "budgetMin must be a positive number"
            });
        }

        if (budgetMaxNum !== undefined && (isNaN(budgetMaxNum) || budgetMaxNum < 0)) {
            return res.status(400).json({
                success: false,
                message: "budgetMax must be a positive number"
            });
        }

        if (budgetMinNum !== undefined && budgetMaxNum !== undefined && budgetMinNum > budgetMaxNum) {
            return res.status(400).json({
                success: false,
                message: "budgetMin cannot be greater than budgetMax"
            });
        }

        if (floorMinNum !== undefined && (isNaN(floorMinNum) || floorMinNum < 0)) {
            return res.status(400).json({
                success: false,
                message: "floorMin must be a positive number"
            });
        }

        if (floorMaxNum !== undefined && (isNaN(floorMaxNum) || floorMaxNum < 0)) {
            return res.status(400).json({
                success: false,
                message: "floorMax must be a positive number"
            });
        }

        if (floorMinNum !== undefined && floorMaxNum !== undefined && floorMinNum > floorMaxNum) {
            return res.status(400).json({
                success: false,
                message: "floorMin cannot be greater than floorMax"
            });
        }

        const updateData = {};
        if (preferredLocations !== undefined) updateData.preferredLocations = preferredLocations;
        if (budgetMinNum !== undefined) updateData.budgetMin = budgetMinNum;
        if (budgetMaxNum !== undefined) updateData.budgetMax = budgetMaxNum;
        if (floorMinNum !== undefined) updateData.floorMin = floorMinNum;
        if (floorMaxNum !== undefined) updateData.floorMax = floorMaxNum;

        const existing = await ContactPreferences.findOne({ userId }).lean();

        let result;

        if (existing) {
            result = await ContactPreferences.findOneAndUpdate(
                { userId },
                updateData,
                { new: true, upsert: false }
            ).lean();
        } else {
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

        if (req.file) {
            profileImage = await uploadToS3(req.file, 'users/profile');
        }

        const updates = {};

        if (firstName !== undefined) updates.firstName = firstName;
        if (lastName !== undefined) updates.lastName = lastName;
        if (email !== undefined) {
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

        if (pincode !== undefined) updates.pincode = pincode;
        if (city !== undefined) updates.city = city;
        if (state !== undefined) updates.state = state;
        if (country !== undefined) updates.country = country;

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update'
            });
        }

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

        const leadsWithVisits = await leadModal.aggregate([
            {
                $match: {
                    userId: new mongoose.Types.ObjectId(userId),
                    isStatus: true,
                    propertyId: { $exists: true, $ne: null }
                }
            },
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
                        { $limit: 1 }
                    ],
                    as: 'visitActivity'
                }
            },
            {
                $match: {
                    'visitActivity.0': { $exists: true }
                }
            },
            {
                $sort: {
                    'visitActivity.visitDate': -1,
                    'visitActivity.activityDate': -1
                }
            }
        ]);

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
                const activityDate = new Date(visitActivity?.activityDate || lead.createdAt);
                activityDate.setHours(0, 0, 0, 0);

                if (activityDate >= today) {
                    upcomingLeads.push(lead);
                } else {
                    completedLeads.push(lead);
                }
            }
        });

        upcomingLeads.sort((a, b) => {
            const dateA = new Date(a.visitActivity[0]?.visitDate || a.visitActivity[0]?.activityDate || a.createdAt);
            const dateB = new Date(b.visitActivity[0]?.visitDate || b.visitActivity[0]?.activityDate || b.createdAt);
            return dateA - dateB;
        });

        completedLeads.sort((a, b) => {
            const dateA = new Date(a.visitActivity[0]?.visitDate || a.visitActivity[0]?.activityDate || a.createdAt);
            const dateB = new Date(b.visitActivity[0]?.visitDate || b.visitActivity[0]?.activityDate || b.createdAt);
            return dateB - dateA;
        });

        const upcomingTotal = upcomingLeads.length;
        const completedTotal = completedLeads.length;

        const upcomingPaginated = upcomingLeads.slice(skip, skip + limit);
        const completedPaginated = completedLeads.slice(skip, skip + limit);

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
