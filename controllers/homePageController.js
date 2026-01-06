const leadModal = require('../models/leadModal');
const Property = require('../models/property');
const UserPropertyActivity = require('../models/userPropertyActivity');
const UserSearchHistory = require('../models/userSearchHistory');
const Developer = require('../models/developer');
const LeadActivity = require('../models/leadActivity');
const Notification = require('../models/notification');
const Blog = require('../models/blog');
const User = require('../models/user');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { logInfo, logError } = require('../utils/logger');

// Helper function to convert connectivity Map to object for JSON response
const convertConnectivityToObject = (connectivity) => {
    if (!connectivity) return {};
    if (connectivity instanceof Map) {
        return Object.fromEntries(connectivity);
    }
    if (typeof connectivity === 'object') {
        return connectivity;
    }
    return {};
};

// Helper function to get favorite property IDs for a user
const getFavoritePropertyIds = async (userId) => {
    if (!userId) return new Set();
    try {
        const favorites = await UserPropertyActivity.find({
            userId: userId,
            activityType: 'favorite'
        }).select('propertyId').lean();
        return new Set(favorites.map(fav => fav.propertyId.toString()));
    } catch (error) {
        logError('Error fetching favorite properties', error, { userId });
        return new Set();
    }
};

// Helper function to get joined group property IDs for a user (properties where user has a lead)
const getJoinedGroupPropertyIds = async (userId) => {
    if (!userId) return new Set();
    try {
        const leads = await leadModal.find({
            userId: userId,
            isStatus: true,
            propertyId: { $exists: true, $ne: null }
        }).select('propertyId').lean();
        return new Set(leads.map(lead => lead.propertyId?.toString()).filter(Boolean));
    } catch (error) {
        logError('Error fetching joined group properties', error, { userId });
        return new Set();
    }
};

// Helper function to get booked visit property IDs for a user (properties where user has booked a visit)
const getBookedVisitPropertyIds = async (userId) => {
    if (!userId) return new Set();
    try {
        // Find leads for the user
        const userLeads = await leadModal.find({
            userId: userId,
            isStatus: true,
            propertyId: { $exists: true, $ne: null }
        }).select('_id propertyId').lean();

        const leadIds = userLeads.map(lead => lead._id);

        if (leadIds.length === 0) return new Set();

        // Find LeadActivity records with activityType 'visit' for these leads
        const visitActivities = await LeadActivity.find({
            leadId: { $in: leadIds },
            activityType: 'visit'
        }).select('leadId').lean();

        // Create a map of leadId to propertyId
        const leadToPropertyMap = new Map(
            userLeads.map(lead => [lead._id.toString(), lead.propertyId?.toString()])
        );

        // Get unique propertyIds from visit activities
        const propertyIds = visitActivities
            .map(activity => leadToPropertyMap.get(activity.leadId.toString()))
            .filter(Boolean);

        return new Set(propertyIds);
    } catch (error) {
        logError('Error fetching booked visit properties', error, { userId });
        return new Set();
    }
};

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

// Helper function to get IP address from request
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

// @desc    Get top properties based on lead count with location filtering
// @route   GET /api/home/getTopProperty
// @access  Public
exports.getTopVisitedProperties = async (req, res, next) => {
    try {
        let { page = 1, limit = 6, location, developer, projectName, possessionStatus, unitType } = req.query;
        page = parseInt(page);
        limit = parseInt(limit);
        const skip = (page - 1) * limit;

        const propertyFilter = { isStatus: true };
        if (developer) propertyFilter.developer = new mongoose.Types.ObjectId(developer);
        if (projectName) propertyFilter.projectName = { $regex: projectName, $options: "i" };
        if (possessionStatus) propertyFilter.possessionStatus = possessionStatus;
        if (location) {
            propertyFilter.location = { $regex: location, $options: "i" };
        }
        if (unitType) propertyFilter["configurations"] = { $elemMatch: { unitType: unitType } };

        const propertiesWithLeads = await leadModal.aggregate([
            { $match: { isStatus: true } },

            {
                $group: {
                    _id: "$propertyId",
                    leadCount: { $sum: 1 },
                    lastLeadDate: { $max: "$date" }
                }
            },

            {
                $lookup: {
                    from: "properties",
                    localField: "_id",
                    foreignField: "_id",
                    as: "property"
                }
            },

            { $unwind: { path: "$property", preserveNullAndEmptyArrays: false } },

            ...(Object.keys(propertyFilter).length ? [{ $match: { "property": propertyFilter } }] : []),

            {
                $addFields: {
                    "property.leadCount": "$leadCount",
                    "property.lastLeadDate": "$lastLeadDate"
                }
            },

            { $replaceRoot: { newRoot: "$property" } }
        ]);

        const propertiesWithoutLeads = await Property.find({
            ...propertyFilter,
            _id: { $nin: propertiesWithLeads.map(p => p._id) }
        })
            .select('projectName location latitude longitude configurations images developerPrice offerPrice discountPercentage minGroupMembers projectId possessionStatus developer reraId description relationshipManager possessionDate')
            .lean();

        const allProperties = [
            ...propertiesWithLeads,
            ...propertiesWithoutLeads.map(prop => ({ ...prop, leadCount: 0, lastLeadDate: null }))
        ];

        allProperties.sort((a, b) => {
            if (b.leadCount !== a.leadCount) {
                return b.leadCount - a.leadCount;
            }
            if (b.lastLeadDate && a.lastLeadDate) {
                return new Date(b.lastLeadDate) - new Date(a.lastLeadDate);
            }
            return 0;
        });

        const total = allProperties.length;
        const rawData = allProperties.slice(skip, skip + limit);

        // Get user ID if authenticated
        const userId = req.user?.userId || null;
        const isAuthenticated = !!userId;

        // Get favorite property IDs for the user
        const favoritePropertyIds = await getFavoritePropertyIds(userId);
        // Get joined group property IDs for the user
        const joinedGroupPropertyIds = await getJoinedGroupPropertyIds(userId);
        // Get booked visit property IDs for the user
        const bookedVisitPropertyIds = await getBookedVisitPropertyIds(userId);

        const developerIds = [...new Set(rawData.map(item => {
            const dev = item.developer;
            if (!dev) return null;
            return dev._id ? dev._id.toString() : dev.toString();
        }).filter(Boolean))];

        const developers = await Developer.find({ _id: { $in: developerIds } })
            .select('_id developerName')
            .lean();
        const developerMap = new Map(developers.map(dev => [dev._id.toString(), dev]));

        const formattedProperties = rawData.map((item) => {
            const property = item;
            const leadCount = property.leadCount || 0;

            const developerId = property.developer?._id
                ? property.developer._id.toString()
                : (property.developer?.toString() || property.developer);
            const developerInfo = developerMap.get(developerId);

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

            const unitTypes = [];
            if (property.configurations && Array.isArray(property.configurations)) {
                property.configurations.forEach(config => {
                    if (config.unitType) {
                        unitTypes.push(config.unitType);
                    }
                });
            }
            const uniqueUnitTypes = [...new Set(unitTypes)];

            // Format images array (cover first, then by order)
            const images = formatPropertyImages(property.images);

            let lastDayToJoin = null;
            if (property.possessionDate) {
                const date = new Date(property.possessionDate);
                lastDayToJoin = date.toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric'
                });
            }

            let discountAmount = 0;
            let discountPercentageValue = 0;
            let offerPriceNum = 0;

            // Helper to parse price (handles both number and string for legacy support)
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

            // Get actual developerPrice and offerPrice from property
            const devPriceNum = parsePriceForDiscount(property.developerPrice);
            offerPriceNum = parsePriceForDiscount(property.offerPrice);

            // Calculate discount
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

            const propertyId = property._id.toString();
            const isFavorite = favoritePropertyIds.has(propertyId);
            const isJoinGroup = joinedGroupPropertyIds.has(propertyId);
            const isBookVisit = bookedVisitPropertyIds.has(propertyId);

            return {
                id: property._id,
                projectId: property.projectId,
                projectName: property.projectName,
                location: property.location,
                latitude: property.latitude || null,
                longitude: property.longitude || null,
                images: images, // Array of images (cover first, then by order)
                image: images.length > 0 ? images[0] : null, // Keep for backward compatibility
                isFavorite: isFavorite,
                isJoinGroup: isJoinGroup,
                isBookVisit: isBookVisit,
                isAuthenticated: isAuthenticated,
                lastDayToJoin: lastDayToJoin ? `Last Day to join ${lastDayToJoin}` : null,
                groupSize: property.minGroupMembers || 0,
                groupSizeFormatted: `${String(property.minGroupMembers || 0).padStart(2, '0')} Members`,
                openingLeft: (() => {
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
                })(),
                openingFormatted: (() => {
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
                    return `${String(count).padStart(2, '0')} Left`;
                })(),
                targetPrice: {
                    value: minPrice,
                    formatted: formatPrice(minPrice)
                },
                developerPrice: {
                    value: devPriceNum,
                    formatted: formatPrice(devPriceNum)
                },
                discount: discountAmount > 0 && discountPercentageValue > 0 ? {
                    amount: discountAmount,
                    amountFormatted: formatPrice(discountAmount),
                    percentage: discountPercentageValue,
                    percentageFormatted: `${discountPercentageValue.toFixed(2)}%`,
                    message: `Get upto ${discountPercentageValue.toFixed(2)}% discount on this property`,
                    displayText: `Up to ${formatPrice(discountAmount)}`
                } : null,
                offerPrice: offerPriceNum > 0 ? formatPrice(offerPriceNum) : null,
                discountPercentage: property.discountPercentage || "00.00%",
                configurations: uniqueUnitTypes,
                configurationsFormatted: uniqueUnitTypes.join(', '),
                possessionStatus: property.possessionStatus || 'N/A',
                developer: developerInfo?.developerName || 'N/A',
                leadCount: leadCount,
                reraId: property.reraId,
                description: property.description,
                relationshipManager: property.relationshipManager ? property.relationshipManager.toString() : null
            };
        });

        logInfo('Top properties fetched (by lead count)', {
            total,
            page,
            limit,
            filters: { location, developer, projectName, possessionStatus, unitType }
        });

        res.json({
            success: true,
            type: "TOP_PROPERTIES",
            message: "Top properties fetched successfully",
            data: formattedProperties,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                hasMore: (page * limit) < total
            },
            filters: {
                location: location || null,
                developer: developer || null,
                projectName: projectName || null,
                possessionStatus: possessionStatus || null,
                unitType: unitType || null
            }
        });

    } catch (error) {
        logError('Error fetching top properties', error, {
            filters: req.query
        });
        next(error);
    }
};

// @desc    Search properties by city and search text with filters (price, BHK, property type, status)
// @route   GET /api/home/search-properties
// @access  Public
exports.searchProperties = async (req, res, next) => {
    try {
        let {
            city,
            searchText,
            page = 1,
            limit = 10,
            priceMin,
            priceMax,
            bhk,
            propertyType,
            projectStatus,
            sortBy = 'leadCount'
        } = req.query;

        page = parseInt(page);
        limit = parseInt(limit);
        const skip = (page - 1) * limit;

        const propertyFilter = { isStatus: true };
        const searchConditions = [];

        if (city) {
            propertyFilter.location = { $regex: city, $options: "i" };
        }

        if (searchText) {
            const searchRegex = { $regex: searchText, $options: "i" };
            searchConditions.push({ projectName: searchRegex });
            searchConditions.push({ location: searchRegex });
        }

        let matchingDeveloperIds = [];
        if (searchText) {
            const matchingDevelopers = await Developer.find({
                developerName: { $regex: searchText, $options: "i" }
            }).select('_id').lean();
            matchingDeveloperIds = matchingDevelopers.map(dev => dev._id);

            if (matchingDeveloperIds.length > 0) {
                searchConditions.push({ developer: { $in: matchingDeveloperIds } });
            }
        }

        if (searchConditions.length > 0) {
            propertyFilter.$or = searchConditions;
        }

        if (priceMin || priceMax) {
            // We'll filter by price after getting properties with calculated prices
            // Store price filters for later use
        }

        if (bhk) {
            propertyFilter["configurations"] = { $elemMatch: { unitType: { $regex: bhk, $options: "i" } } };
        }

        if (propertyType) {
            const typeRegex = { $regex: propertyType, $options: "i" };
            if (!propertyFilter.$or) propertyFilter.$or = [];
            propertyFilter.$or.push({ projectName: typeRegex });
            propertyFilter.$or.push({ "configurations.unitType": typeRegex });
        }

        if (projectStatus) {
            if (projectStatus === 'Pre Launch') {
                propertyFilter.possessionStatus = 'Under Construction';
            } else {
                propertyFilter.possessionStatus = projectStatus;
            }
        }

        const propertiesWithLeads = await leadModal.aggregate([
            { $match: { isStatus: true } },
            {
                $group: {
                    _id: "$propertyId",
                    leadCount: { $sum: 1 },
                    lastLeadDate: { $max: "$date" }
                }
            },
            {
                $lookup: {
                    from: "properties",
                    localField: "_id",
                    foreignField: "_id",
                    as: "property"
                }
            },
            { $unwind: { path: "$property", preserveNullAndEmptyArrays: false } },
            { $match: { "property": propertyFilter } },
            {
                $addFields: {
                    "property.leadCount": "$leadCount",
                    "property.lastLeadDate": "$lastLeadDate"
                }
            },
            { $replaceRoot: { newRoot: "$property" } }
        ]);

        const propertiesWithoutLeads = await Property.find({
            ...propertyFilter,
            _id: { $nin: propertiesWithLeads.map(p => p._id) }
        })
            .select('projectName location latitude longitude configurations images developerPrice offerPrice discountPercentage minGroupMembers projectId possessionStatus developer reraId description relationshipManager possessionDate projectSize')
            .lean();

        let allProperties = [
            ...propertiesWithLeads,
            ...propertiesWithoutLeads.map(prop => ({ ...prop, leadCount: 0, lastLeadDate: null, createdAt: prop.createdAt || new Date() }))
        ];

        const parsePriceToNumber = (priceStr) => {
            if (!priceStr) return 0;
            let priceNum = parseFloat(priceStr.replace(/[₹,\s]/g, '')) || 0;
            const priceStrLower = priceStr.toLowerCase();
            if (priceStrLower.includes('lakh') || priceStrLower.includes('l')) {
                priceNum = priceNum * 100000;
            } else if (priceStrLower.includes('cr') || priceStrLower.includes('crore')) {
                priceNum = priceNum * 10000000;
            }
            return priceNum;
        };

        if (priceMin || priceMax) {
            const minPriceFilter = priceMin ? parsePriceToNumber(priceMin) : 0;
            const maxPriceFilter = priceMax ? parsePriceToNumber(priceMax) : Infinity;

            allProperties = allProperties.filter(property => {
                const prices = extractPricesFromConfigurations(
                    property.configurations,
                    property.developerPrice || property.offerPrice || '0'
                ).map(priceStr => parsePriceToNumber(priceStr)).filter(p => p > 0);

                if (prices.length === 0) return false;

                const minPrice = Math.min(...prices);
                const maxPrice = Math.max(...prices);

                // Property matches if any price falls within the range
                return (minPrice >= minPriceFilter && minPrice <= maxPriceFilter) ||
                    (maxPrice >= minPriceFilter && maxPrice <= maxPriceFilter) ||
                    (minPrice <= minPriceFilter && maxPrice >= maxPriceFilter);
            });
        }

        if (sortBy === 'newAdded') {
            allProperties.sort((a, b) => {
                const dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
                const dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
                return dateB - dateA; // Newest first
            });
        } else if (sortBy === 'priceLow') {
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
            allProperties.sort((a, b) => {
                const fallbackA = parsePrice(a.developerPrice || a.offerPrice || 0);
                const fallbackB = parsePrice(b.developerPrice || b.offerPrice || 0);
                const pricesA = extractPricesFromConfigurations(a.configurations, fallbackA);
                const pricesB = extractPricesFromConfigurations(b.configurations, fallbackB);
                const priceA = pricesA.length > 0 ? Math.min(...pricesA) : 0;
                const priceB = pricesB.length > 0 ? Math.min(...pricesB) : 0;
                return priceA - priceB;
            });
        } else if (sortBy === 'priceHigh') {
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
            allProperties.sort((a, b) => {
                const fallbackA = parsePrice(a.developerPrice || a.offerPrice || 0);
                const fallbackB = parsePrice(b.developerPrice || b.offerPrice || 0);
                const pricesA = extractPricesFromConfigurations(a.configurations, fallbackA);
                const pricesB = extractPricesFromConfigurations(b.configurations, fallbackB);
                const priceA = pricesA.length > 0 ? Math.max(...pricesA) : 0;
                const priceB = pricesB.length > 0 ? Math.max(...pricesB) : 0;
                return priceB - priceA;
            });
        } else {
            // Default: Sort by lead count (descending), then by last lead date
            allProperties.sort((a, b) => {
                if (b.leadCount !== a.leadCount) {
                    return b.leadCount - a.leadCount;
                }
                if (b.lastLeadDate && a.lastLeadDate) {
                    return new Date(b.lastLeadDate) - new Date(a.lastLeadDate);
                }
                return 0;
            });
        }

        const total = allProperties.length;
        const paginatedProperties = allProperties.slice(skip, skip + limit);

        // Get user ID if authenticated
        const userId = req.user?.userId || null;
        const isAuthenticated = !!userId;

        // Get favorite property IDs for the user
        const favoritePropertyIds = await getFavoritePropertyIds(userId);
        // Get joined group property IDs for the user
        const joinedGroupPropertyIds = await getJoinedGroupPropertyIds(userId);

        const developerIds = [...new Set(paginatedProperties.map(item => {
            const dev = item.developer;
            if (!dev) return null;
            return dev._id ? dev._id.toString() : dev.toString();
        }).filter(Boolean))];

        const developers = await Developer.find({ _id: { $in: developerIds } })
            .select('_id developerName')
            .lean();
        const developerMap = new Map(developers.map(dev => [dev._id.toString(), dev]));

        const formattedProperties = paginatedProperties.map((property) => {
            const leadCount = property.leadCount || 0;

            const developerId = property.developer?._id
                ? property.developer._id.toString()
                : (property.developer?.toString() || property.developer);
            const developerInfo = developerMap.get(developerId);

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

            const unitTypes = [...new Set(property.configurations?.map(config => config.unitType).filter(Boolean) || [])];

            // Format images array (cover first, then by order)
            const images = formatPropertyImages(property.images);

            let lastDayToJoin = null;
            if (property.possessionDate) {
                const date = new Date(property.possessionDate);
                lastDayToJoin = date.toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric'
                });
            }

            let discountAmount = 0;
            let discountPercentageValue = 0;
            let offerPriceNum = 0;

            if (property.discountPercentage) {
                discountPercentageValue = parseFloat(property.discountPercentage.replace('%', '')) || 0;
            }

            if (property.developerPrice && property.offerPrice) {
                // Helper to parse price (handles both number and string for legacy support)
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
                const devPrice = parsePriceForDiscount(property.developerPrice);
                offerPriceNum = parsePriceForDiscount(property.offerPrice);

                if (devPrice > 0 && offerPriceNum > 0 && devPrice > offerPriceNum) {
                    discountAmount = devPrice - offerPriceNum;
                    if (!property.discountPercentage) {
                        discountPercentageValue = parseFloat(((discountAmount / devPrice) * 100).toFixed(2));
                    }
                }
            }

            const formatPrice = (amount) => {
                if (amount >= 10000000) {
                    return `₹ ${(amount / 10000000).toFixed(2)} Crore`;
                } else if (amount >= 100000) {
                    return `₹ ${(amount / 100000).toFixed(2)} Lakh`;
                } else {
                    return `₹ ${amount.toLocaleString('en-IN')}`;
                }
            };

            const propertyId = property._id.toString();
            const isFavorite = favoritePropertyIds.has(propertyId);
            const isJoinGroup = joinedGroupPropertyIds.has(propertyId);
            const isBookVisit = bookedVisitPropertyIds.has(propertyId);

            return {
                id: property._id,
                projectId: property.projectId,
                projectName: property.projectName,
                location: property.location,
                latitude: property.latitude || null,
                longitude: property.longitude || null,
                images: images, // Array of images (cover first, then by order)
                image: images.length > 0 ? images[0] : null, // Keep for backward compatibility
                isFavorite: isFavorite,
                isJoinGroup: isJoinGroup,
                isBookVisit: isBookVisit,
                isAuthenticated: isAuthenticated,
                lastDayToJoin: lastDayToJoin ? `Last Day to join ${lastDayToJoin}` : null,
                groupSize: property.minGroupMembers || 0,
                groupSizeFormatted: `${String(property.minGroupMembers || 0).padStart(2, '0')} Members`,
                openingLeft: property.configurations?.filter(c => c.availabilityStatus === 'Available').length || 0,
                openingFormatted: `${String(property.configurations?.filter(c => c.availabilityStatus === 'Available').length || 0).padStart(2, '0')} Left`,
                targetPrice: {
                    value: minPrice,
                    formatted: formatPrice(minPrice)
                },
                developerPrice: {
                    value: maxPrice,
                    formatted: formatPrice(maxPrice)
                },
                discount: discountAmount > 0 ? {
                    amount: discountAmount,
                    amountFormatted: formatPrice(discountAmount),
                    percentage: discountPercentageValue,
                    percentageFormatted: property.discountPercentage || `${discountPercentageValue.toFixed(2)}%`,
                    message: discountPercentageValue > 0 ? `Get upto ${discountPercentageValue}% discount on this property` : null,
                    displayText: `Up to ${formatPrice(discountAmount)}`
                } : null,
                offerPrice: property.offerPrice || null,
                discountPercentage: property.discountPercentage || "00.00%",
                configurations: unitTypes,
                configurationsFormatted: unitTypes.join(', '),
                possessionStatus: property.possessionStatus || 'N/A',
                developer: developerInfo?.developerName || 'N/A',
                leadCount: leadCount,
                reraId: property.reraId,
                description: property.description,
                relationshipManager: property.relationshipManager || null
            };
        });

        // Note: userId already declared above for favorite check
        let searchHistoryData = null;

        if (userId && (searchText || city)) {
            try {
                const trimmedSearchQuery = searchText?.trim() || city?.trim();
                const trimmedLocation = city?.trim() || '';
                const trimmedProjectName = null;

                const existingSearch = await UserSearchHistory.findOne({
                    userId,
                    searchQuery: trimmedSearchQuery,
                    location: trimmedLocation,
                    projectName: trimmedProjectName,
                    ...(matchingDeveloperIds.length > 0 ? { developer: { $in: matchingDeveloperIds } } : {})
                }).lean();

                if (existingSearch) {
                    searchHistoryData = existingSearch;
                    await UserSearchHistory.updateOne(
                        { _id: existingSearch._id },
                        { updatedAt: new Date() }
                    );
                } else {
                    searchHistoryData = await UserSearchHistory.create({
                        userId,
                        searchQuery: trimmedSearchQuery,
                        location: trimmedLocation,
                        projectName: trimmedProjectName,
                        ...(matchingDeveloperIds.length > 0 ? { developer: matchingDeveloperIds[0] } : {})
                    });
                }

                logInfo('Search history saved for user', {
                    userId,
                    searchQuery: trimmedSearchQuery,
                    location: trimmedLocation,
                    searchHistoryId: searchHistoryData._id
                });
            } catch (error) {
                logError('Error saving search history', error, {
                    userId,
                    searchText,
                    city
                });
            }
        }

        logInfo('Properties searched', {
            total,
            page,
            limit,
            userId: userId || null,
            hasSearchHistory: !!searchHistoryData,
            filters: { city, searchText, priceMin, priceMax, bhk, propertyType, projectStatus, sortBy }
        });

        res.json({
            success: true,
            type: "SEARCH_RESULTS",
            message: "Properties fetched successfully",
            data: formattedProperties,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                hasMore: (page * limit) < total
            },
            filters: {
                city: city || null,
                searchText: searchText || null,
                priceMin: priceMin || null,
                priceMax: priceMax || null,
                bhk: bhk || null,
                propertyType: propertyType || null,
                projectStatus: projectStatus || null,
                sortBy: sortBy || 'leadCount'
            },
            summary: {
                title: searchText || city || "All Properties",
                subtitle: `${total} properties found`,
                description: searchText
                    ? `Search results for "${searchText}"`
                    : city
                        ? `Properties in ${city}`
                        : "Browse all available properties"
            },
            ...(searchHistoryData ? { searchHistory: { id: searchHistoryData._id, saved: true } } : {})
        });

    } catch (error) {
        logError('Error searching properties', error, {
            filters: req.query
        });
        next(error);
    }
};

// @desc    Get all unique locations with property counts (sorted by count)
// @route   GET /api/home/locations
// @access  Public
exports.getLocations = async (req, res, next) => {
    try {
        // Get locations sorted by lead count (top 7 only)
        const locations = await leadModal.aggregate([
            { $match: { isStatus: true } },
            {
                $lookup: {
                    from: "properties",
                    localField: "propertyId",
                    foreignField: "_id",
                    as: "property"
                }
            },
            { $unwind: { path: "$property", preserveNullAndEmptyArrays: false } },
            { $match: { "property.isStatus": true, "property.location": { $ne: null, $ne: "" } } },
            {
                $group: {
                    _id: "$property.location",
                    leadCount: { $sum: 1 }
                }
            },
            { $sort: { leadCount: -1 } },
            { $limit: 7 },
            {
                $project: {
                    _id: 0,
                    location: "$_id",
                    propertyCount: "$leadCount"
                }
            }
        ]);

        const uniqueLocations = locations.map(item => item.location).filter(Boolean);

        logInfo('Top 7 locations fetched by lead count', {
            totalLocations: uniqueLocations.length
        });

        res.json({
            success: true,
            message: "Locations fetched successfully",
            data: {
                locations: uniqueLocations,
                locationsWithCount: locations,
                total: uniqueLocations.length
            }
        });

    } catch (error) {
        logError('Error fetching locations', error);
        next(error);
    }
};

// @desc    Get detailed property information with similar projects
// @route   GET /api/home/getTopPropertyById/:id
// @access  Private (authenticated)
exports.getPropertyById = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid property ID" });
        }

        const property = await Property.findById(id)
            .populate('developer', 'developerName description city establishedYear totalProjects logo website sourcingManager')
            .populate('relationshipManager', 'name email phone')
            .populate('leadDistributionAgents', 'name email phone')
            .lean();

        if (!property) {
            logInfo('Property not found', { propertyId: id });
            return res.status(404).json({ success: false, message: "Property not found" });
        }

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

        const areas = [];
        if (property.configurations && Array.isArray(property.configurations)) {
            property.configurations.forEach(config => {
                if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
                    config.subConfigurations.forEach(subConfig => {
                        const carpetArea = parseFloat(subConfig.carpetArea?.replace(/[sqft,\s]/gi, '') || '0');
                        if (carpetArea > 0) areas.push(carpetArea);
                    });
                } else {
                    const carpetArea = parseFloat(config.carpetArea?.replace(/[sqft,\s]/gi, '') || '0');
                    if (carpetArea > 0) areas.push(carpetArea);
                }
            });
        }

        const minArea = areas.length > 0 ? Math.min(...areas) : 0;
        const maxArea = areas.length > 0 ? Math.max(...areas) : 0;

        const unitTypes = [...new Set(property.configurations.map(config => config.unitType).filter(Boolean))];

        // Format images array (cover first, then by order)
        const images = formatPropertyImages(property.images);
        const mainImage = images.length > 0 ? images[0] : null;
        const thumbnails = images.slice(1, 5);

        let possessionDateFormatted = null;
        if (property.possessionDate) {
            const date = new Date(property.possessionDate);
            possessionDateFormatted = date.toLocaleDateString('en-IN', {
                month: 'long',
                year: 'numeric'
            });
        }

        const formatPrice = (amount) => {
            if (amount >= 10000000) {
                return `₹ ${(amount / 10000000).toFixed(2)} Crore`;
            } else if (amount >= 100000) {
                return `₹ ${(amount / 100000).toFixed(2)} Lakh`;
            } else {
                return `₹ ${amount.toLocaleString('en-IN')}`;
            }
        };

        // Get user ID if authenticated
        const userId = req.user?.userId || null;
        const isAuthenticated = !!userId;

        // Check if property is favorited by the user
        const favoritePropertyIds = await getFavoritePropertyIds(userId);
        // Check if user has joined the group for this property
        const joinedGroupPropertyIds = await getJoinedGroupPropertyIds(userId);
        // Check if user has booked a visit for this property
        const bookedVisitPropertyIds = await getBookedVisitPropertyIds(userId);
        const propertyId = property._id.toString();
        const isFavorite = favoritePropertyIds.has(propertyId);
        const isJoinGroup = joinedGroupPropertyIds.has(propertyId);
        const isBookVisit = bookedVisitPropertyIds.has(propertyId);

        const propertyDetails = {
            id: property._id,
            projectId: property.projectId,
            projectName: property.projectName,
            location: property.location,
            latitude: property.latitude || null,
            longitude: property.longitude || null,
            isFavorite: isFavorite,
            isJoinGroup: isJoinGroup,
            isBookVisit: isBookVisit,
            isAuthenticated: isAuthenticated,
            locationDetails: {
                full: property.location,
                area: property.location.split(',')[0]?.trim() || property.location,
                city: property.location.split(',')[1]?.trim() || '',
                state: property.location.split(',')[2]?.trim() || ''
            },
            startingPrice: {
                value: minPrice,
                formatted: formatPrice(minPrice)
            },
            bookingDeadlinePrice: {
                value: maxPrice,
                formatted: formatPrice(maxPrice),
                note: maxPrice > minPrice ? `Up to ${formatPrice(maxPrice)} on properties` : null
            },
            developerPrice: property.developerPrice || null,
            offerPrice: property.offerPrice || null,
            discountPercentage: property.discountPercentage || "00.00%",
            reraId: property.reraId,
            reraQrImage: property.reraQrImage,
            reraDetailsLink: property.reraQrImage || null,
            overview: {
                units: property.configurations?.length || 0,
                configurations: unitTypes,
                configurationsFormatted: unitTypes.join(', '),
                possessionStatus: property.possessionStatus || 'N/A',
                areaRange: {
                    min: minArea,
                    max: maxArea,
                    formatted: minArea > 0 && maxArea > 0 ? `${minArea}-${maxArea} SQFT.` : 'N/A'
                },
                reraNumber: property.reraId || 'N/A',
                possessionDate: property.possessionDate,
                possessionDateFormatted: possessionDateFormatted,
                plotSize: property.landParcel || property.projectSize || 'N/A',
                propertyType: 'Residential'
            },
            description: property.description || '',
            rating: 5,
            highlights: property.highlights || [],
            amenities: property.amenities || [],
            images: images, // Array of all images (cover first, then by order)
            image: mainImage, // Keep for backward compatibility
            imageDetails: {
                main: mainImage,
                thumbnails: thumbnails
            },
            layoutPlans: (() => {
                const layoutPlans = [];
                if (property.configurations && Array.isArray(property.configurations)) {
                    property.configurations.forEach(config => {
                        if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
                            config.subConfigurations.forEach(subConfig => {
                                if (subConfig.layoutPlanImages && subConfig.layoutPlanImages.length > 0) {
                                    subConfig.layoutPlanImages.forEach(imageUrl => {
                                        layoutPlans.push({
                                            image: imageUrl,
                                            unitType: config.unitType,
                                            carpetArea: subConfig.carpetArea,
                                            price: subConfig.price
                                        });
                                    });
                                }
                            });
                        }
                    });
                }
                if (property.layouts && Array.isArray(property.layouts)) {
                    property.layouts.forEach(layout => {
                        const matchingConfig = property.configurations?.find(
                            c => c.unitType === layout.configurationUnitType
                        );
                        layoutPlans.push({
                            image: layout.image || layout,
                            unitType: layout.configurationUnitType || null,
                            area: matchingConfig ? matchingConfig.carpetArea : null,
                            price: matchingConfig?.price || null
                        });
                    });
                }
                return layoutPlans;
            })(),
            neighborhood: {
                connectivity: convertConnectivityToObject(property.connectivity),
                mapCoordinates: (() => {
                    const conn = convertConnectivityToObject(property.connectivity);
                    if (conn) {
                        for (const category in conn) {
                            if (Array.isArray(conn[category]) && conn[category].length > 0) {
                                return conn[category][0] || null;
                            }
                        }
                    }
                    return null;
                })()
            },
            developer: property.developer ? {
                id: property.developer._id,
                name: property.developer.developerName,
                description: property.developer.description || '',
                logo: property.developer.logo,
                city: property.developer.city,
                establishedYear: property.developer.establishedYear,
                yearsOfExperience: property.developer.establishedYear
                    ? new Date().getFullYear() - property.developer.establishedYear
                    : null,
                totalProjects: property.developer.totalProjects || 0,
                website: property.developer.website,
                sourcingManager: property.developer.sourcingManager
            } : null,
            relationshipManager: property.relationshipManager ? {
                id: property.relationshipManager._id,
                name: property.relationshipManager.name,
                email: property.relationshipManager.email,
                phone: property.relationshipManager.phone
            } : null,
            configurations: property.configurations ? property.configurations.map(config => {
                if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
                    return {
                        unitType: config.unitType,
                        subConfigurations: config.subConfigurations.map(subConfig => ({
                            carpetArea: subConfig.carpetArea,
                            price: subConfig.price,
                            availabilityStatus: subConfig.availabilityStatus,
                            layoutPlanImages: subConfig.layoutPlanImages || []
                        }))
                    };
                } else {
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
                    return {
                        unitType: config.unitType,
                        subConfigurations: [{
                            carpetArea: config.carpetArea || '',
                            price: parsePrice(config.price),
                            availabilityStatus: config.availabilityStatus || 'Available',
                            layoutPlanImages: []
                        }]
                    };
                }
            }) : [],
            projectSize: property.projectSize,
            landParcel: property.landParcel,
            minGroupMembers: property.minGroupMembers,
            createdAt: property.createdAt,
            updatedAt: property.updatedAt
        };

        const groupBuyData = await getGroupBuyDetails(id, property.minGroupMembers || 0);

        propertyDetails.groupBuy = groupBuyData;

        const similarProjects = await findSimilarProjects(property, minPrice, maxPrice);

        if (req.user && req.user.userId) {
            try {
                const userId = req.user.userId;
                const propertyId = id;

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
                    logInfo('Property view updated in history', { userId, propertyId });
                } else {
                    await UserPropertyActivity.create({
                        userId,
                        propertyId,
                        activityType: "viewed",
                        lastViewedAt: new Date()
                    });
                    logInfo('Property view added to history', { userId, propertyId });
                }
            } catch (viewError) {
                logError('Error adding property to view history', viewError, { propertyId: id });
            }
        }

        logInfo('Property details fetched', { propertyId: id });
        res.json({
            success: true,
            message: 'Property details fetched successfully',
            data: {
                property: propertyDetails,
                similarProjects: similarProjects
            }
        });

    } catch (error) {
        logError('Error fetching property details', error, { propertyId: id });
        next(error);
    }
};

// Helper function to get Group Buy details
const getGroupBuyDetails = async (propertyId, minGroupMembers) => {
    try {
        const groupLeads = await leadModal.find({
            propertyId: propertyId,
            isStatus: true
        })
            .populate({
                path: 'userId',
                select: 'name email phone profileImage'
            })
            .populate({
                path: 'propertyId',
                select: 'configurations'
            })
            .sort({ createdAt: -1 })
            .lean();

        const uniqueUsers = new Map();
        groupLeads.forEach(lead => {
            const userId = lead.userId?._id?.toString();
            if (userId && !uniqueUsers.has(userId)) {
                uniqueUsers.set(userId, lead);
            }
        });

        const groupMembers = Array.from(uniqueUsers.values()).map(lead => {
            const user = lead.userId || {};
            const property = lead.propertyId || {};

            const propertyTypeInterest = property.configurations?.[0]?.unitType || 'N/A';

            return {
                userId: user._id || null,
                name: user.name || 'N/A',
                profilePhoto: user.profileImage || null,
                contactNumber: user.phone || 'N/A',
                email: user.email || 'N/A',
                propertyTypeInterest: propertyTypeInterest,
                joinedAt: lead.createdAt || lead.date
            };
        });

        const currentGroupMembersCount = groupMembers.length;

        const progressPercentage = minGroupMembers > 0
            ? Math.min(100, Math.round((currentGroupMembersCount / minGroupMembers) * 100))
            : 0;

        const isMinimumMet = currentGroupMembersCount >= minGroupMembers;

        return {
            minGroupMembers: minGroupMembers || 0,
            currentGroupMembersCount: currentGroupMembersCount,
            progressPercentage: progressPercentage,
            isMinimumMet: isMinimumMet,
            progressText: `${currentGroupMembersCount}/${minGroupMembers}`,
            message: isMinimumMet
                ? `Great! ${minGroupMembers} members have joined. Enjoy the ultimate deal!`
                : `Enjoy the ultimate deal after at least ${minGroupMembers} people join!`,
            members: groupMembers
        };

    } catch (error) {
        logError('Error fetching group buy details', error, { propertyId });
        return {
            minGroupMembers: minGroupMembers || 0,
            currentGroupMembersCount: 0,
            progressPercentage: 0,
            isMinimumMet: false,
            progressText: `0/${minGroupMembers}`,
            message: `Enjoy the ultimate deal after at least ${minGroupMembers} people join!`,
            members: []
        };
    }
};

// Helper function to find similar projects
const findSimilarProjects = async (currentProperty, minPrice, maxPrice) => {
    try {
        const avgPrice = (minPrice + maxPrice) / 2;
        const priceTolerance = avgPrice * 0.3;

        const nearbyMinPrice = Math.max(0, avgPrice - priceTolerance);
        const nearbyMaxPrice = avgPrice + priceTolerance;

        const currentLocation = currentProperty.location.toLowerCase().trim();
        const locationParts = currentLocation.split(',').map(part => part.trim()).filter(Boolean);

        const currentArea = locationParts[0] || '';
        const currentCity = locationParts[1] || locationParts[0] || '';
        const currentState = locationParts[2] || '';

        const allProperties = await Property.find({
            _id: { $ne: currentProperty._id },
            isStatus: true,
            $or: [
                { 'configurations.subConfigurations.availabilityStatus': { $in: ['Available', 'Ready'] } },
                { 'configurations.availabilityStatus': { $in: ['Available', 'Ready'] } } // Legacy support
            ]
        })
            .populate('developer', 'developerName')
            .select('projectName location latitude longitude configurations images developerPrice offerPrice discountPercentage minGroupMembers projectId possessionStatus possessionDate developer')
            .lean();

        const scoredProperties = allProperties.map(prop => {
            let score = 0;
            let budgetMatch = false;
            let locationMatch = false;

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
            const fallbackPrice = parsePrice(prop.developerPrice || prop.offerPrice || 0);
            const propPrices = extractPricesFromConfigurations(prop.configurations, fallbackPrice);

            const propMinPrice = propPrices.length > 0 ? Math.min(...propPrices) : 0;
            const propMaxPrice = propPrices.length > 0 ? Math.max(...propPrices) : 0;
            const propAvgPrice = propPrices.length > 0 ? (propMinPrice + propMaxPrice) / 2 : 0;

            if (propAvgPrice > 0) {
                if (propAvgPrice >= nearbyMinPrice && propAvgPrice <= nearbyMaxPrice) {
                    score += 50;
                    budgetMatch = true;
                } else {
                    const priceDiff = Math.abs(propAvgPrice - avgPrice);
                    const priceDiffPercent = avgPrice > 0 ? (priceDiff / avgPrice) : 1;

                    if (priceDiffPercent <= 0.5) {
                        score += 50 * (1 - priceDiffPercent);
                        budgetMatch = true;
                    } else if (priceDiffPercent <= 0.7) {
                        score += 25 * (1 - priceDiffPercent / 0.7);
                    }
                }
            }

            const propLocation = prop.location.toLowerCase().trim();
            const propLocationParts = propLocation.split(',').map(part => part.trim()).filter(Boolean);
            const propArea = propLocationParts[0] || '';
            const propCity = propLocationParts[1] || propLocationParts[0] || '';
            const propState = propLocationParts[2] || '';

            if (propLocation === currentLocation) {
                score += 50;
                locationMatch = true;
            }
            else if (currentArea && propArea && propArea === currentArea) {
                score += 40;
                locationMatch = true;
            }
            else if (currentCity && propCity && propCity === currentCity) {
                score += 35;
                locationMatch = true;
            }
            else if (currentState && propState && propState === currentState) {
                score += 20;
            }
            else {
                const matchingKeywords = locationParts.filter(part => {
                    if (part.length < 3) return false;
                    return propLocation.includes(part);
                });

                if (matchingKeywords.length > 0) {
                    score += (matchingKeywords.length / locationParts.length) * 30;
                    if (matchingKeywords.length >= 2) {
                        locationMatch = true;
                    }
                }
            }

            if ((budgetMatch || locationMatch) && prop.developer?._id?.toString() === currentProperty.developer?._id?.toString()) {
                score += 10;
            }

            return {
                property: prop,
                score: score,
                budgetMatch: budgetMatch,
                locationMatch: locationMatch
            };
        });
        const topSimilar = scoredProperties
            .filter(item => {
                return (item.budgetMatch || item.locationMatch) && item.score >= 30;
            })
            .sort((a, b) => {
                const aBothMatches = a.budgetMatch && a.locationMatch ? 1 : 0;
                const bBothMatches = b.budgetMatch && b.locationMatch ? 1 : 0;
                if (aBothMatches !== bBothMatches) {
                    return bBothMatches - aBothMatches;
                }
                return b.score - a.score;
            })
            .slice(0, 3)
            .map(item => {
                const prop = item.property;
                const simPrices = extractPricesFromConfigurations(prop.configurations, prop.developerPrice || '0');
                const simMinPrice = simPrices.length > 0 ? Math.min(...simPrices) : 0;
                const simMaxPrice = simPrices.length > 0 ? Math.max(...simPrices) : 0;
                const simUnitTypes = [...new Set(prop.configurations.map(config => config.unitType).filter(Boolean))];
                const simImages = formatPropertyImages(prop.images);
                let openingDate = null;
                if (prop.possessionDate) {
                    const date = new Date(prop.possessionDate);
                    openingDate = date.toLocaleDateString('en-IN', {
                        month: 'long',
                        year: 'numeric'
                    });
                }

                return {
                    id: prop._id,
                    projectId: prop.projectId,
                    projectName: prop.projectName,
                    images: simImages, // Array of all images (cover first, then by order)
                    imageUrl: simImages.length > 0 ? simImages[0] : null, // Keep for backward compatibility
                    status: prop.possessionStatus === 'Under Construction'
                        ? (openingDate ? `Opening ${openingDate}` : 'Opening soon')
                        : 'Available',
                    groupSize: prop.minGroupMembers || 0,
                    configuration: simUnitTypes[0] || 'N/A',
                    targetPrice: {
                        value: simMinPrice,
                        formatted: simMinPrice >= 10000000
                            ? `₹ ${(simMinPrice / 10000000).toFixed(2)} Crore`
                            : simMinPrice >= 100000
                                ? `₹ ${(simMinPrice / 100000).toFixed(2)} Lakh`
                                : `₹ ${simMinPrice.toLocaleString('en-IN')}`
                    },
                    disclaimerPrice: {
                        value: simMaxPrice,
                        formatted: simMaxPrice >= 10000000
                            ? `₹ ${(simMaxPrice / 10000000).toFixed(2)} Crore`
                            : simMaxPrice >= 100000
                                ? `₹ ${(simMaxPrice / 100000).toFixed(2)} Lakh`
                                : `₹ ${simMaxPrice.toLocaleString('en-IN')}`
                    },
                    location: prop.location,
                    latitude: prop.latitude || null,
                    longitude: prop.longitude || null,
                    offerPrice: prop.offerPrice || null,
                    discountPercentage: prop.discountPercentage || "00.00%",
                    similarityScore: Math.round(item.score)
                };
            });

        return topSimilar;

    } catch (error) {
        logError('Error finding similar projects', error);
        return [];
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

        logInfo('Property view added', { userId, propertyId });
        res.json({ success: true, message: "View added successfully" });

    } catch (error) {
        logError('Error adding property view', error, { userId, propertyId });
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
            logInfo('Property removed from favorites', { userId, propertyId });
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

        logInfo('Property added to favorites', { userId, propertyId });
        res.json({ success: true, message: "Added to favorites" });

    } catch (error) {
        logError('Error toggling favorite property', error, { userId, propertyId });
        res.json({ success: false, message: error.message });
    }
};

// Helper function to add timeline activity
const addTimelineActivity = async (leadId, activityType, performedBy, performedByName, description = '', metadata = {}) => {
    try {
        await LeadActivity.create({
            leadId,
            activityType,
            performedBy,
            performedByName,
            description,
            activityDate: new Date(),
            metadata
        });
    } catch (error) {
        logError('Error adding timeline activity', error, { leadId, activityType });
    }
};

// Helper function to create notifications for relevant users
const createNotification = async (leadId, notificationType, source, sourceId, title, message, metadata = {}) => {
    try {
        const lead = await leadModal.findById(leadId)
            .populate('propertyId', 'relationshipManager leadDistributionAgents projectName projectId')
            .populate('userId', 'name')
            .lean();

        if (!lead || !lead.propertyId) {
            return;
        }

        const property = lead.propertyId;
        const leadUser = lead.userId || {};

        const recipients = [];

        if (property.relationshipManager) {
            recipients.push(property.relationshipManager);
        }

        if (property.leadDistributionAgents && Array.isArray(property.leadDistributionAgents)) {
            recipients.push(...property.leadDistributionAgents);
        }

        const uniqueRecipients = [...new Set(recipients.map(r => r.toString()))];

        const notificationPromises = uniqueRecipients.map(userId => {
            return Notification.create({
                userId,
                leadId,
                propertyId: property._id,
                notificationType,
                title,
                message,
                source,
                sourceId,
                metadata: {
                    projectName: property.projectName || 'N/A',
                    projectId: property.projectId || 'N/A',
                    leadContactName: leadUser.name || 'N/A',
                    ...metadata
                }
            });
        });

        await Promise.all(notificationPromises);
    } catch (error) {
        logError('Error creating notification', error, { leadId, notificationType });
    }
};

// @desc    Join Group Buy for a property
// @route   POST /api/home/join-group
// @access  Private (authenticated)
exports.joinGroup = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { propertyId, source = "origin", ipAddress: ipAddressFromBody } = req.body;

        const property = await Property.findById(propertyId)
            .populate('relationshipManager', 'name email phone')
            .select('relationshipManager projectName')
            .lean();
        if (!property) {
            logInfo('Property not found for join group', { propertyId });
            return res.status(404).json({ success: false, message: "Property not found" });
        }

        let existingLead = await leadModal.findOne({
            userId,
            propertyId,
            isStatus: true
        }).lean();

        let lead;
        if (existingLead) {
            lead = existingLead;
            logInfo('Lead already exists, using existing lead for join group', {
                leadId: lead._id,
                userId,
                propertyId
            });
            // IP address should not be updated for existing leads
        } else {
            // Get IP address: prefer from request body, fallback to extracting from request headers
            const ipAddress = ipAddressFromBody || getClientIpAddress(req);

            lead = await leadModal.create({
                userId,
                propertyId,
                relationshipManagerId: property.relationshipManager?._id,
                rmEmail: property.relationshipManager?.email || "",
                rmPhone: property.relationshipManager?.phone || "",
                isStatus: true,
                source: source || "origin",
                updatedBy: userId,
                ipAddress: ipAddress // Store IP address only on first lead creation
            });
            logInfo('New lead created for join group', {
                leadId: lead._id,
                userId,
                propertyId,
                ipAddress: ipAddress
            });
        }

        const user = await User.findById(userId).select('name').lean();
        const performedByName = user?.name || 'User';

        await addTimelineActivity(
            lead._id,
            'join_group',
            userId,
            performedByName,
            `${performedByName} joined the group buy for ${property.projectName}`,
            { propertyId: propertyId.toString(), source }
        );

        await createNotification(
            lead._id,
            'join_group',
            performedByName,
            userId,
            'Join Group',
            `${performedByName} joined the group buy for ${property.projectName}`,
            { propertyId: propertyId.toString(), source }
        );

        logInfo('User joined group', { userId, propertyId, leadId: lead._id });
        res.json({
            success: true,
            message: "Successfully joined the group buy",
            data: {
                leadId: lead._id,
                propertyId,
                joinedAt: new Date()
            }
        });

    } catch (error) {
        logError('Error joining group', error, { userId, propertyId: req.body.propertyId });
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.registerVisit = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { propertyId, visitDate, visitTime, source = "origin", ipAddress: ipAddressFromBody } = req.body;

        const property = await Property.findById(propertyId)
            .populate('relationshipManager', 'name email phone')
            .select('relationshipManager projectName')
            .lean();
        if (!property) {
            logInfo('Property not found for visit registration', { propertyId });
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

        let existingLead = await leadModal.findOne({
            userId,
            propertyId,
            isStatus: true
        }).lean();

        let lead;
        if (existingLead) {
            lead = existingLead;
            await leadModal.updateOne(
                { _id: lead._id },
                {
                    visitStatus: 'visited',
                    updatedBy: userId
                    // IP address should not be updated for existing leads
                }
            );
        } else {
            // Get IP address: prefer from request body, fallback to extracting from request headers
            const ipAddress = ipAddressFromBody || getClientIpAddress(req);

            lead = await leadModal.create({
                userId,
                propertyId,
                relationshipManagerId: property.relationshipManager?._id,
                rmEmail: property.relationshipManager?.email || "",
                rmPhone: property.relationshipManager?.phone || "",
                isStatus: true,
                source: source || "origin",
                updatedBy: userId,
                visitStatus: 'visited',
                ipAddress: ipAddress // Store IP address only on first lead creation
            });
            logInfo('New lead created for visit registration', {
                leadId: lead._id,
                userId,
                propertyId,
                ipAddress: ipAddress
            });
        }

        const user = await User.findById(userId).select('name').lean();
        const performedByName = user?.name || 'User';

        const visitDateTime = parsedVisitDate
            ? `${parsedVisitDate.toLocaleDateString('en-IN')} ${visitTime || ''}`.trim()
            : new Date().toLocaleString('en-IN');

        await addTimelineActivity(
            lead._id,
            'visit',
            userId,
            performedByName,
            `Visit registered by ${performedByName} on ${visitDateTime}`,
            {
                propertyId: propertyId.toString(),
                visitDate: parsedVisitDate,
                visitTime,
                source
            }
        );

        await createNotification(
            lead._id,
            'visit',
            performedByName,
            userId,
            'Visit Activity',
            `Visit registered by ${performedByName} on ${visitDateTime}`,
            {
                propertyId: propertyId.toString(),
                visitDate: parsedVisitDate,
                visitTime,
                source
            }
        );

        logInfo('Visit registered and lead created/updated', { userId, propertyId, source, leadId: lead._id });
        res.json({
            success: true,
            message: "Visit registered & lead created/updated successfully",
            data: {
                leadId: lead._id
            }
        });

    } catch (error) {
        logError('Error registering visit', error, { userId, propertyId });
        res.status(500).json({ success: false, message: error.message });
    }
};

// @desc    Contact Us - Create lead without property
// @route   POST /api/home/contact-us
// @access  Public (or Private if user is logged in)
exports.contactUs = async (req, res, next) => {
    try {
        const { name, email, phone, message, source = "contact_us" } = req.body;
        const userId = req.user?.userId;

        if (!name || !email || !phone) {
            return res.status(400).json({
                success: false,
                message: "Name, email, and phone are required"
            });
        }

        if (phone.length !== 10 || !/^\d+$/.test(phone)) {
            return res.status(400).json({
                success: false,
                message: "Phone number must be 10 digits"
            });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Invalid email format"
            });
        }

        let user;
        let leadUserId;

        if (userId) {
            user = await User.findById(userId).select('name email phone').lean();
            if (user) {
                leadUserId = userId;
            }
        }

        if (!leadUserId) {
            user = await User.findOne({
                $or: [
                    { email: email.toLowerCase().trim() },
                    { phone: phone }
                ]
            }).select('_id name email phone').lean();

            if (user) {
                leadUserId = user._id;
            } else {
                const RoleModel = require('../models/role');
                const bcrypt = require('bcryptjs');

                let defaultRole = await RoleModel.findOne({ name: 'User' }).select('_id').lean();
                if (!defaultRole) {
                    defaultRole = await RoleModel.create({
                        name: 'User',
                        permissions: {
                            property: { add: false, edit: false, view: true, delete: false },
                            developer: { add: false, edit: false, view: true, delete: false },
                            crm: { add: false, edit: false, view: false, delete: false, export: false },
                            team: { add: false, edit: false, view: false, delete: false }
                        }
                    });
                }

                const randomPassword = crypto.randomBytes(8).toString('hex');
                const salt = await bcrypt.genSalt(10);
                const hashedPassword = await bcrypt.hash(randomPassword, salt);

                const newUser = await User.create({
                    name,
                    email: email.toLowerCase().trim(),
                    phone,
                    password: hashedPassword,
                    role: defaultRole._id
                });

                leadUserId = newUser._id;
                user = {
                    _id: newUser._id,
                    name: newUser.name,
                    email: newUser.email,
                    phone: newUser.phone
                };
            }
        }

        const RoleModel = require('../models/role');
        const projectManagerRole = await RoleModel.findOne({ name: 'Project Manager' }).select('_id').lean();
        const adminRole = await RoleModel.findOne({ name: 'Admin' }).select('_id').lean();

        let defaultRM = null;
        if (projectManagerRole) {
            defaultRM = await User.findOne({ role: projectManagerRole._id })
                .select('_id name email phone')
                .lean();
        }

        if (!defaultRM && adminRole) {
            defaultRM = await User.findOne({ role: adminRole._id })
                .select('_id name email phone')
                .lean();
        }

        const ipAddress = getClientIpAddress(req);

        const lead = await leadModal.create({
            userId: leadUserId,
            propertyId: null,
            relationshipManagerId: defaultRM?._id || null,
            rmEmail: defaultRM?.email || '',
            rmPhone: defaultRM?.phone || '',
            message: message || '',
            isStatus: true,
            source: source,
            status: 'pending',
            visitStatus: 'not_visited',
            ipAddress: ipAddress
        });

        if (lead._id) {
            const activityPerformedBy = defaultRM?._id || leadUserId;
            const activityPerformedByName = defaultRM?.name || user?.name || 'System';

            await addTimelineActivity(
                lead._id,
                'join_group',
                activityPerformedBy,
                activityPerformedByName,
                `${name} contacted us via Contact Us form${message ? `: ${message}` : ''}`,
                {
                    source: 'contact_us',
                    email,
                    phone,
                    message: message || ''
                }
            );
        }

        logInfo('Contact Us lead created', {
            leadId: lead._id,
            userId: leadUserId,
            email,
            phone,
            hasProperty: false
        });

        res.status(201).json({
            success: true,
            message: "Thank you for contacting us! We'll get back to you soon.",
            data: {
                leadId: lead._id,
                userId: leadUserId,
                name: user.name,
                email: user.email,
                phone: user.phone
            }
        });

    } catch (error) {
        logError('Error creating contact us lead', error, {
            email: req.body.email,
            phone: req.body.phone
        });
        res.status(500).json({
            success: false,
            message: error.message || "Error submitting contact form"
        });
    }
};

// ===================== BLOG SECTION =====================

// ===================== GET ALL BLOGS (Homepage) =====================
// @desc    Get all published blogs for homepage
// @route   GET /api/home/blogs
// @access  Public
exports.getAllBlogs = async (req, res, next) => {
    try {
        const {
            page = 1,
            limit = 10,
            category,
            tag,
            search,
            sortBy = 'newest' // newest, oldest, views
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const filter = {
            isStatus: true,
            isPublished: true
        };

        if (category) {
            filter.category = { $regex: category, $options: 'i' };
        }

        if (tag) {
            filter.tags = { $in: [new RegExp(tag, 'i')] };
        }

        if (search) {
            filter.$or = [
                { title: { $regex: search, $options: 'i' } },
                { subtitle: { $regex: search, $options: 'i' } },
                { content: { $regex: search, $options: 'i' } },
                { category: { $regex: search, $options: 'i' } },
                { tags: { $in: [new RegExp(search, 'i')] } }
            ];
        }

        let sortCriteria = {};
        if (sortBy === 'newest') {
            sortCriteria = { createdAt: -1 };
        } else if (sortBy === 'oldest') {
            sortCriteria = { createdAt: 1 };
        } else if (sortBy === 'views') {
            sortCriteria = { views: -1 };
        } else {
            sortCriteria = { createdAt: -1 };
        }

        const total = await Blog.countDocuments(filter);

        const blogs = await Blog.find(filter)
            .populate('author', 'name profileImage')
            .select('title subtitle category author authorName tags bannerImage slug views createdAt content')
            .sort(sortCriteria)
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        const formattedBlogs = blogs.map(blog => {
            const date = new Date(blog.createdAt);
            const formattedDate = date.toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric'
            });

            return {
                _id: blog._id,
                title: blog.title,
                author: blog.authorName || blog.author?.name || 'Admin',
                authorImage: blog.author?.profileImage || null,
                tags: blog.tags || [],
                bannerImage: blog.bannerImage || null,
                slug: blog.slug,
                content: blog.content || '',
                date: formattedDate,
                views: blog.views || 0,
                createdAt: blog.createdAt
            };
        });

        logInfo('Blogs fetched for homepage', { total, page, limit, category, tag });

        res.json({
            success: true,
            message: 'Blogs fetched successfully',
            data: formattedBlogs,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit)),
                hasMore: (parseInt(page) * parseInt(limit)) < total
            }
        });

    } catch (error) {
        logError('Error fetching blogs for homepage', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===================== GET BLOG BY ID OR SLUG (Homepage) =====================
// @desc    Get single blog by ID or slug for homepage
// @route   GET /api/home/blog/:idOrSlug
// @access  Public
exports.getBlogById = async (req, res, next) => {
    try {
        const { idOrSlug } = req.params;
        const isObjectId = mongoose.Types.ObjectId.isValid(idOrSlug);

        const filter = {
            isStatus: true,
            isPublished: true
        };

        if (isObjectId) {
            filter._id = idOrSlug;
        } else {
            filter.slug = idOrSlug;
        }

        const blog = await Blog.findOne(filter)
            .populate('author', 'name email profileImage')
            .lean();

        if (!blog) {
            return res.status(404).json({
                success: false,
                message: 'Blog not found'
            });
        }

        await Blog.findByIdAndUpdate(blog._id, { $inc: { views: 1 } });

        const date = new Date(blog.createdAt);
        const formattedDate = date.toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
        });

        const formattedBlog = {
            _id: blog._id,
            title: blog.title,
            subtitle: blog.subtitle || '',
            category: blog.category || '',
            author: {
                id: blog.author?._id || blog.author,
                name: blog.authorName || blog.author?.name || 'Admin',
                email: blog.author?.email || null,
                profileImage: blog.author?.profileImage || null
            },
            tags: blog.tags || [],
            bannerImage: blog.bannerImage || null,
            galleryImages: blog.galleryImages || [],
            content: blog.content,
            slug: blog.slug,
            date: formattedDate,
            views: (blog.views || 0) + 1,
            createdAt: blog.createdAt,
            updatedAt: blog.updatedAt
        };

        logInfo('Blog fetched for homepage', { blogId: blog._id, slug: blog.slug });

        res.json({
            success: true,
            message: 'Blog fetched successfully',
            data: formattedBlog
        });

    } catch (error) {
        logError('Error fetching blog for homepage', error, { idOrSlug: req.params.idOrSlug });
        res.status(500).json({ success: false, message: error.message });
    }
};

// @desc    Compare multiple properties
// @route   POST /api/home/compare
// @access  Public (or Private if needed)
exports.compareProperties = async (req, res, next) => {
    try {
        const { propertyIds } = req.body;

        if (!propertyIds || !Array.isArray(propertyIds)) {
            return res.status(400).json({
                success: false,
                message: 'propertyIds must be an array'
            });
        }

        if (propertyIds.length === 0 || propertyIds.length > 3) {
            return res.status(400).json({
                success: false,
                message: 'Please provide 1 to 3 property IDs for comparison'
            });
        }

        const invalidIds = propertyIds.filter(id => !mongoose.Types.ObjectId.isValid(id));
        if (invalidIds.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Invalid property IDs: ${invalidIds.join(', ')}`
            });
        }

        const properties = await Property.find({
            _id: { $in: propertyIds },
            isStatus: true
        })
            .populate('developer', 'developerName')
            .populate('relationshipManager', 'name email phone')
            .select('projectName developer location latitude longitude configurations images possessionDate possessionStatus projectId developerPrice offerPrice discountPercentage')
            .lean();

        if (properties.length !== propertyIds.length) {
            const foundIds = properties.map(p => p._id.toString());
            const missingIds = propertyIds.filter(id => !foundIds.includes(id));
            return res.status(404).json({
                success: false,
                message: `Properties not found: ${missingIds.join(', ')}`
            });
        }

        // Get user ID if authenticated
        const userId = req.user?.userId || null;
        const isAuthenticated = !!userId;

        // Get favorite property IDs for the user
        const favoritePropertyIds = await getFavoritePropertyIds(userId);
        // Get joined group property IDs for the user
        const joinedGroupPropertyIds = await getJoinedGroupPropertyIds(userId);

        // Sort properties to match the order of propertyIds in the request
        // This ensures pin labels (A, B, C) match the order properties were selected
        const propertyMap = new Map(properties.map(p => [p._id.toString(), p]));
        const orderedProperties = propertyIds.map(id => propertyMap.get(id.toString())).filter(Boolean);

        // Add pin labels (A, B, C, D...) to each property based on the order they were selected
        const formattedProperties = orderedProperties.map((property, index) => {
            // Generate pin label: A, B, C, D, etc. (65 is ASCII for 'A')
            const pinLabel = String.fromCharCode(65 + index);

            const propertyId = property._id.toString();
            const isFavorite = favoritePropertyIds.has(propertyId);
            const isJoinGroup = joinedGroupPropertyIds.has(propertyId);
            const isBookVisit = bookedVisitPropertyIds.has(propertyId);

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


            if (property.developerPrice) {
                const devPrice = parsePrice(property.developerPrice);
                if (devPrice > 0) prices.push(devPrice);
            }

            const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
            const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

            const areas = [];
            if (property.configurations && Array.isArray(property.configurations)) {
                property.configurations.forEach(config => {
                    if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
                        config.subConfigurations.forEach(subConfig => {
                            const carpetArea = parseFloat(subConfig.carpetArea?.replace(/[sqft,\s]/gi, '') || '0');
                            if (carpetArea > 0) areas.push(carpetArea);
                        });
                    } else {
                        const carpetArea = parseFloat(config.carpetArea?.replace(/[sqft,\s]/gi, '') || '0');
                        if (carpetArea > 0) areas.push(carpetArea);
                    }
                });
            }

            const minArea = areas.length > 0 ? Math.min(...areas) : 0;
            const maxArea = areas.length > 0 ? Math.max(...areas) : 0;

            const unitTypes = [...new Set(property.configurations.map(config => config.unitType).filter(Boolean))];

            // Format images array (cover first, then by order)
            const images = formatPropertyImages(property.images);

            const floorPlans = [];
            // Format fullConfigurations with all nested data including layout images
            const fullConfigurations = [];

            if (property.configurations && Array.isArray(property.configurations)) {
                property.configurations.forEach(config => {
                    const configData = {
                        _id: config._id,
                        unitType: config.unitType,
                        subConfigurations: []
                    };

                    if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
                        config.subConfigurations.forEach(subConfig => {
                            const subConfigData = {
                                _id: subConfig._id,
                                carpetArea: subConfig.carpetArea,
                                price: subConfig.price,
                                availabilityStatus: subConfig.availabilityStatus || 'Available',
                                layoutPlanImages: subConfig.layoutPlanImages || []
                            };

                            configData.subConfigurations.push(subConfigData);

                            // Add to floorPlans if layout images exist
                            if (subConfig.layoutPlanImages && subConfig.layoutPlanImages.length > 0) {
                                subConfig.layoutPlanImages.forEach(imageUrl => {
                                    floorPlans.push({
                                        image: imageUrl,
                                        unitType: config.unitType,
                                        carpetArea: subConfig.carpetArea,
                                        price: subConfig.price,
                                        availabilityStatus: subConfig.availabilityStatus || 'Available'
                                    });
                                });
                            }
                        });
                    }

                    fullConfigurations.push(configData);
                });
            }

            // Legacy layouts support (if exists)
            if (property.layouts && Array.isArray(property.layouts)) {
                property.layouts.forEach(layout => {
                    floorPlans.push({
                        image: layout.image || layout,
                        unitType: layout.configurationUnitType || null
                    });
                });
            }

            let possessionDateFormatted = null;
            if (property.possessionDate) {
                const date = new Date(property.possessionDate);
                possessionDateFormatted = date.toLocaleDateString('en-IN', {
                    month: 'short',
                    year: 'numeric'
                });
            }

            // Ensure latitude and longitude are valid numbers
            const latitude = property.latitude && !isNaN(property.latitude) && isFinite(property.latitude)
                ? parseFloat(property.latitude) : null;
            const longitude = property.longitude && !isNaN(property.longitude) && isFinite(property.longitude)
                ? parseFloat(property.longitude) : null;

            // Check if property has valid map coordinates
            const hasMapCoordinates = latitude !== null && longitude !== null &&
                latitude >= -90 && latitude <= 90 &&
                longitude >= -180 && longitude <= 180;

            return {
                id: property._id,
                projectId: property.projectId,
                projectName: property.projectName,
                developer: property.developer?.developerName || 'N/A',
                developerId: property.developer?._id || null,
                location: property.location,
                latitude: latitude,
                longitude: longitude,
                hasMapCoordinates: hasMapCoordinates, // Flag to indicate if property can be shown on map
                pinLabel: pinLabel, // A, B, C, D, etc. - Always included for all properties
                isFavorite: isFavorite,
                isJoinGroup: isJoinGroup,
                isBookVisit: isBookVisit,
                isAuthenticated: isAuthenticated,
                propertyType: 'Residential',
                developerPrice: property.developerPrice || null,
                offerPrice: property.offerPrice || null,
                discountPercentage: property.discountPercentage || "00.00%",
                budget: {
                    min: minPrice,
                    max: maxPrice,
                    formatted: minPrice > 0 && maxPrice > 0
                        ? `₹ ${(minPrice / 10000000).toFixed(2)} Cr - ${(maxPrice / 10000000).toFixed(2)} Cr`
                        : 'Price on Request'
                },
                area: {
                    min: minArea,
                    max: maxArea,
                    formatted: minArea > 0 && maxArea > 0
                        ? `${minArea} - ${maxArea} sqft`
                        : 'Area on Request'
                },
                configurations: unitTypes,
                configurationsFormatted: unitTypes.join(', '),
                images: images, // Array of all images (cover first, then by order)
                mainImage: images.length > 0 ? images[0] : null, // Keep for backward compatibility
                floorPlans: floorPlans,
                possessionDate: property.possessionDate,
                possessionDateFormatted: possessionDateFormatted,
                possessionStatus: property.possessionStatus || 'N/A',
                relationshipManager: property.relationshipManager ? {
                    id: property.relationshipManager._id,
                    name: property.relationshipManager.name,
                    email: property.relationshipManager.email,
                    phone: property.relationshipManager.phone
                } : null,
                fullConfigurations: fullConfigurations
            };
        });

        // Log pin labels for debugging
        const pinLabelsInfo = formattedProperties.map(p => ({
            id: p.id,
            projectName: p.projectName,
            pinLabel: p.pinLabel,
            hasMapCoordinates: p.hasMapCoordinates,
            latitude: p.latitude,
            longitude: p.longitude
        }));

        logInfo('Properties compared', {
            propertyCount: formattedProperties.length,
            propertyIds: propertyIds,
            pinLabels: pinLabelsInfo
        });

        res.json({
            success: true,
            message: 'Properties fetched for comparison',
            data: formattedProperties,
            count: formattedProperties.length,
            // Include metadata about pin labels for frontend
            metadata: {
                totalProperties: formattedProperties.length,
                propertiesWithCoordinates: formattedProperties.filter(p => p.hasMapCoordinates).length,
                pinLabels: formattedProperties.map(p => ({
                    id: p.id,
                    pinLabel: p.pinLabel,
                    hasMapCoordinates: p.hasMapCoordinates
                }))
            }
        });

    } catch (error) {
        logError('Error comparing properties', error, { propertyIds: req.body.propertyIds });
        next(error);
    }
};

// @desc    Calculate EMI (Equated Monthly Installment)
// @route   POST /api/home/emi-calculator
// @access  Public
exports.calculateEMI = async (req, res, next) => {
    try {
        const { loanAmount, rateOfInterest, loanTenure, currency = 'INR' } = req.body;

        if (!loanAmount || loanAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Loan amount must be greater than 0'
            });
        }

        if (!rateOfInterest || rateOfInterest <= 0 || rateOfInterest > 100) {
            return res.status(400).json({
                success: false,
                message: 'Rate of interest must be between 0 and 100'
            });
        }

        if (!loanTenure || loanTenure <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Loan tenure must be greater than 0'
            });
        }

        let principalAmount = parseFloat(loanAmount);

        if (typeof loanAmount === 'string') {
            const amountStr = loanAmount.toLowerCase().trim();
            if (amountStr.includes('crore') || amountStr.includes('cr')) {
                const num = parseFloat(amountStr.replace(/[₹,\s]/g, '').replace(/crore|cr/gi, ''));
                principalAmount = num * 10000000;
            } else if (amountStr.includes('lakh') || amountStr.includes('l')) {
                const num = parseFloat(amountStr.replace(/[₹,\s]/g, '').replace(/lakh|l/gi, ''));
                principalAmount = num * 100000;
            } else {
                principalAmount = parseFloat(amountStr.replace(/[₹,\s]/g, '')) || principalAmount;
            }
        }

        const monthlyRate = parseFloat(rateOfInterest) / 12 / 100;

        const tenureMonths = parseInt(loanTenure);

        const monthlyEMI = principalAmount * monthlyRate * Math.pow(1 + monthlyRate, tenureMonths) /
            (Math.pow(1 + monthlyRate, tenureMonths) - 1);

        const totalAmountPayable = monthlyEMI * tenureMonths;

        const totalInterest = totalAmountPayable - principalAmount;

        const interestComponent = principalAmount * monthlyRate;
        const principalComponent = monthlyEMI - interestComponent;

        const formatCurrency = (amount) => {
            if (amount >= 10000000) {
                return `₹ ${(amount / 10000000).toFixed(2)} Cr`;
            } else if (amount >= 100000) {
                return `₹ ${(amount / 100000).toFixed(2)} Lakh`;
            } else if (amount >= 1000) {
                return `₹ ${(amount / 1000).toFixed(2)}k`;
            } else {
                return `₹ ${amount.toFixed(2)}`;
            }
        };

        const formatCurrencySimple = (amount) => {
            return `₹ ${amount.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
        };

        const result = {
            monthlyEMI: {
                value: Math.round(monthlyEMI),
                formatted: formatCurrencySimple(Math.round(monthlyEMI))
            },
            principalAmount: {
                value: principalAmount,
                formatted: formatCurrencySimple(principalAmount),
                display: formatCurrency(principalAmount)
            },
            totalInterest: {
                value: Math.round(totalInterest),
                formatted: formatCurrencySimple(Math.round(totalInterest))
            },
            totalAmountPayable: {
                value: Math.round(totalAmountPayable),
                formatted: formatCurrencySimple(Math.round(totalAmountPayable))
            },
            emiBreakdown: {
                principal: Math.round(principalComponent),
                interest: Math.round(interestComponent),
                principalPercentage: Math.round((principalComponent / monthlyEMI) * 100),
                interestPercentage: Math.round((interestComponent / monthlyEMI) * 100)
            },
            input: {
                loanAmount: principalAmount,
                rateOfInterest: parseFloat(rateOfInterest),
                loanTenure: tenureMonths,
                currency: currency
            },
            totalPrincipalPaid: {
                value: principalAmount,
                formatted: formatCurrencySimple(principalAmount)
            },
            disclaimer: "Calculated EMI result is indicative only."
        };

        logInfo('EMI calculated', {
            loanAmount: principalAmount,
            rateOfInterest: rateOfInterest,
            loanTenure: tenureMonths,
            monthlyEMI: Math.round(monthlyEMI)
        });

        res.json({
            success: true,
            message: 'EMI calculated successfully',
            data: result
        });

    } catch (error) {
        logError('Error calculating EMI', error, {
            loanAmount: req.body.loanAmount,
            rateOfInterest: req.body.rateOfInterest,
            loanTenure: req.body.loanTenure
        });
        next(error);
    }
};

// @desc    Get all properties with search and location-based filtering
// @route   GET /api/home/properties
// @access  Public
exports.getAllProperties = async (req, res, next) => {
    try {
        let {
            page = 1,
            limit = 12,
            search,
            latitude,
            longitude,
            radius = 30 // Default 30 km radius
        } = req.query;

        page = parseInt(page);
        limit = parseInt(limit);
        const skip = (page - 1) * limit;

        // Build filter
        const filter = { isStatus: true };

        // Search by property name if search keyword provided
        if (search && search.trim()) {
            filter.projectName = { $regex: search.trim(), $options: 'i' };
        }

        // Get user ID if authenticated
        const userId = req.user?.userId || null;
        const isAuthenticated = !!userId;

        // Get favorite property IDs for the user
        const favoritePropertyIds = await getFavoritePropertyIds(userId);
        // Get joined group property IDs for the user
        const joinedGroupPropertyIds = await getJoinedGroupPropertyIds(userId);

        // Get all properties matching the filter
        let properties = await Property.find(filter)
            .populate('developer', 'developerName')
            .populate('relationshipManager', 'name email phone')
            .select('projectName location latitude longitude configurations images developerPrice offerPrice discountPercentage minGroupMembers projectId possessionStatus developer reraId description relationshipManager possessionDate createdAt')
            .lean();

        // Location-based filtering (30 km radius) if latitude and longitude provided
        if (latitude && longitude) {
            const userLat = parseFloat(latitude);
            const userLon = parseFloat(longitude);
            const radiusKm = parseFloat(radius) || 30;

            // Validate coordinates
            if (isNaN(userLat) || isNaN(userLon) || userLat < -90 || userLat > 90 || userLon < -180 || userLon > 180) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid latitude or longitude values"
                });
            }

            // Haversine formula to calculate distance between two points
            const calculateDistance = (lat1, lon1, lat2, lon2) => {
                const R = 6371; // Earth's radius in kilometers
                const dLat = (lat2 - lat1) * Math.PI / 180;
                const dLon = (lon2 - lon1) * Math.PI / 180;
                const a =
                    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                    Math.sin(dLon / 2) * Math.sin(dLon / 2);
                const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                return R * c; // Distance in kilometers
            };

            // Filter properties within radius
            properties = properties.filter(property => {
                if (!property.latitude || !property.longitude) {
                    return false; // Exclude properties without coordinates
                }
                const distance = calculateDistance(
                    userLat,
                    userLon,
                    property.latitude,
                    property.longitude
                );
                property.distance = distance; // Add distance to property object
                return distance <= radiusKm;
            });

            // Sort by distance (nearest first)
            properties.sort((a, b) => (a.distance || Infinity) - (b.distance || Infinity));
        }

        // If no search keyword and no location filter, use default listing logic
        // (sort by lead count or creation date)
        if (!search && !latitude && !longitude) {
            // Get lead counts for properties
            const propertyIds = properties.map(p => p._id);
            const leadCounts = await leadModal.aggregate([
                { $match: { propertyId: { $in: propertyIds }, isStatus: true } },
                { $group: { _id: '$propertyId', count: { $sum: 1 } } }
            ]);

            const leadCountMap = new Map(
                leadCounts.map(item => [item._id.toString(), item.count])
            );

            // Add lead count to properties
            properties = properties.map(prop => ({
                ...prop,
                leadCount: leadCountMap.get(prop._id.toString()) || 0
            }));

            // Sort by lead count (descending), then by creation date
            properties.sort((a, b) => {
                if (b.leadCount !== a.leadCount) {
                    return b.leadCount - a.leadCount;
                }
                return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
            });
        }

        // Calculate total before pagination
        const total = properties.length;

        // Apply pagination
        const paginatedProperties = properties.slice(skip, skip + limit);

        // Format properties for response
        const formattedProperties = paginatedProperties.map(property => {
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

            // Get unit types
            const unitTypes = [];
            if (property.configurations && Array.isArray(property.configurations)) {
                property.configurations.forEach(config => {
                    if (config.unitType) {
                        unitTypes.push(config.unitType);
                    }
                });
            }
            const uniqueUnitTypes = [...new Set(unitTypes)];

            // Format images array (cover first, then by order)
            const images = formatPropertyImages(property.images);

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

            const propertyId = property._id.toString();
            const isFavorite = favoritePropertyIds.has(propertyId);
            const isJoinGroup = joinedGroupPropertyIds.has(propertyId);

            return {
                id: property._id,
                projectId: property.projectId,
                projectName: property.projectName,
                location: property.location,
                latitude: property.latitude || null,
                longitude: property.longitude || null,
                images: images, // Array of images (cover first, then by order)
                image: images.length > 0 ? images[0] : null, // Keep for backward compatibility
                isFavorite: isFavorite,
                isJoinGroup: isJoinGroup,
                isBookVisit: isBookVisit,
                isAuthenticated: isAuthenticated,
                priceRange: {
                    min: minPrice,
                    max: maxPrice,
                    minFormatted: formatPrice(minPrice),
                    maxFormatted: formatPrice(maxPrice)
                },
                configurations: uniqueUnitTypes,
                configurationsFormatted: uniqueUnitTypes.join(', '),
                possessionStatus: property.possessionStatus || 'N/A',
                developer: property.developer?.developerName || 'N/A',
                developerPrice: property.developerPrice ? {
                    value: parsePrice(property.developerPrice),
                    formatted: formatPrice(parsePrice(property.developerPrice))
                } : null,
                offerPrice: property.offerPrice ? {
                    value: parsePrice(property.offerPrice),
                    formatted: formatPrice(parsePrice(property.offerPrice))
                } : null,
                discountPercentage: property.discountPercentage || "00.00%",
                minGroupMembers: property.minGroupMembers || 0,
                reraId: property.reraId,
                description: property.description,
                distance: property.distance ? parseFloat(property.distance.toFixed(2)) : null // Distance in km if location filter applied
            };
        });

        logInfo('Properties fetched', {
            total,
            page,
            limit,
            search: search || null,
            locationFilter: (latitude && longitude) ? { latitude, longitude, radius } : null
        });

        res.json({
            success: true,
            message: "Properties fetched successfully",
            data: formattedProperties,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                hasMore: (page * limit) < total
            },
            filters: {
                search: search || null,
                latitude: latitude ? parseFloat(latitude) : null,
                longitude: longitude ? parseFloat(longitude) : null,
                radius: radius ? parseFloat(radius) : null
            }
        });

    } catch (error) {
        logError('Error fetching properties', error, {
            query: req.query
        });
        next(error);
    }
};
