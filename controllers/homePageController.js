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

// Helper function to extract prices from configurations (handles both old and new format)
// Price is now stored as Number (in rupees), but we handle legacy string format too
const extractPricesFromConfigurations = (configurations, fallbackPrice = 0) => {
    const prices = [];
    if (!configurations || !Array.isArray(configurations)) return prices;

    // Helper to parse price (handles both number and string)
    const parsePrice = (price) => {
        if (!price) return 0;
        // If already a number, return it
        if (typeof price === 'number') return price;
        // Parse string price
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
            // New format: subConfigurations array (price is Number)
            config.subConfigurations.forEach(subConfig => {
                const priceNum = parsePrice(subConfig.price || fallbackPrice);
                if (priceNum > 0) prices.push(priceNum);
            });
        } else {
            // Legacy format: direct price field (might be string)
            const priceNum = parsePrice(config.price || fallbackPrice);
            if (priceNum > 0) prices.push(priceNum);
        }
    });

    return prices;
};

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

// @desc    Get top properties based on lead count with location filtering
// @route   GET /api/home/getTopProperty
// @access  Public
exports.getTopVisitedProperties = async (req, res, next) => {
    try {
        let { page = 1, limit = 10, location, developer, projectName, possessionStatus, unitType } = req.query;
        page = parseInt(page);
        limit = parseInt(limit);
        const skip = (page - 1) * limit;

        // Build property filter
        const propertyFilter = { isStatus: true };
        if (developer) propertyFilter.developer = new mongoose.Types.ObjectId(developer);
        if (projectName) propertyFilter.projectName = { $regex: projectName, $options: "i" };
        if (possessionStatus) propertyFilter.possessionStatus = possessionStatus;
        if (location) {
            // Support both exact match and partial match for location
            propertyFilter.location = { $regex: location, $options: "i" };
        }
        if (unitType) propertyFilter["configurations"] = { $elemMatch: { unitType: unitType } };

        // Aggregate to get properties with lead counts
        // First, get all properties that match filters
        const propertiesWithLeads = await leadModal.aggregate([
            // Match active leads only
            { $match: { isStatus: true } },

            // Group by propertyId to count leads
            {
                $group: {
                    _id: "$propertyId",
                    leadCount: { $sum: 1 },
                    lastLeadDate: { $max: "$date" }
                }
            },

            // Lookup property details
            {
                $lookup: {
                    from: "properties",
                    localField: "_id",
                    foreignField: "_id",
                    as: "property"
                }
            },

            // Unwind property array
            { $unwind: { path: "$property", preserveNullAndEmptyArrays: false } },

            // Apply property filters
            ...(Object.keys(propertyFilter).length ? [{ $match: { "property": propertyFilter } }] : []),

            // Add leadCount to property for sorting
            {
                $addFields: {
                    "property.leadCount": "$leadCount",
                    "property.lastLeadDate": "$lastLeadDate"
                }
            },

            // Replace root with property
            { $replaceRoot: { newRoot: "$property" } }
        ]);

        // Get properties without leads that match filters
        const propertiesWithoutLeads = await Property.find({
            ...propertyFilter,
            _id: { $nin: propertiesWithLeads.map(p => p._id) }
        })
            .select('projectName location latitude longitude configurations images developerPrice offerPrice discountPercentage minGroupMembers projectId possessionStatus developer reraId description relationshipManager possessionDate')
            .lean();

        // Combine and add leadCount = 0 for properties without leads
        const allProperties = [
            ...propertiesWithLeads,
            ...propertiesWithoutLeads.map(prop => ({ ...prop, leadCount: 0, lastLeadDate: null }))
        ];

        // Sort by lead count (descending), then by last lead date
        allProperties.sort((a, b) => {
            if (b.leadCount !== a.leadCount) {
                return b.leadCount - a.leadCount;
            }
            if (b.lastLeadDate && a.lastLeadDate) {
                return new Date(b.lastLeadDate) - new Date(a.lastLeadDate);
            }
            return 0;
        });

        // Apply pagination
        const total = allProperties.length;
        const rawData = allProperties.slice(skip, skip + limit);

        // Get all unique developer IDs and fetch them in one query
        const developerIds = [...new Set(rawData.map(item => {
            const dev = item.developer;
            if (!dev) return null;
            // Handle ObjectId or string
            return dev._id ? dev._id.toString() : dev.toString();
        }).filter(Boolean))];

        const developers = await Developer.find({ _id: { $in: developerIds } })
            .select('_id developerName')
            .lean();
        const developerMap = new Map(developers.map(dev => [dev._id.toString(), dev]));

        // Format properties for UI cards
        const formattedProperties = rawData.map((item) => {
            const property = item; // Already replaced root in aggregation
            const leadCount = property.leadCount || 0;

            // Get developer info from map
            const developerId = property.developer?._id
                ? property.developer._id.toString()
                : (property.developer?.toString() || property.developer);
            const developerInfo = developerMap.get(developerId);

            // Calculate price ranges from subConfigurations
            const prices = extractPricesFromConfigurations(property.configurations, property.developerPrice || '0');

            const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
            const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

            // Get unit types from configurations
            const unitTypes = [];
            if (property.configurations && Array.isArray(property.configurations)) {
                property.configurations.forEach(config => {
                    if (config.unitType) {
                        unitTypes.push(config.unitType);
                    }
                });
            }
            const uniqueUnitTypes = [...new Set(unitTypes)];

            // Get cover image
            const coverImage = property.images?.find(img => img.isCover)?.url || property.images?.[0]?.url || null;

            // Format possession date for "Last Day to join" banner
            let lastDayToJoin = null;
            if (property.possessionDate) {
                const date = new Date(property.possessionDate);
                lastDayToJoin = date.toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric'
                });
            }

            // Calculate discount (difference between developer price and offer price)
            let discountAmount = 0;
            let discountPercentageValue = 0;
            let offerPriceNum = 0;

            // Use stored discountPercentage from model
            if (property.discountPercentage) {
                discountPercentageValue = parseFloat(property.discountPercentage.replace('%', '')) || 0;
            }

            if (property.developerPrice && property.offerPrice) {
                let devPrice = parseFloat(property.developerPrice.replace(/[₹,\s]/g, '')) || 0;
                offerPriceNum = parseFloat(property.offerPrice.replace(/[₹,\s]/g, '')) || 0;

                // Handle currency conversion for developer price
                const devPriceStr = property.developerPrice.toLowerCase();
                if (devPriceStr.includes('lakh') || devPriceStr.includes('l')) {
                    devPrice = devPrice * 100000;
                } else if (devPriceStr.includes('cr') || devPriceStr.includes('crore')) {
                    devPrice = devPrice * 10000000;
                }

                // Handle currency conversion for offer price
                const offerPriceStr = property.offerPrice.toLowerCase();
                if (offerPriceStr.includes('lakh') || offerPriceStr.includes('l')) {
                    offerPriceNum = offerPriceNum * 100000;
                } else if (offerPriceStr.includes('cr') || offerPriceStr.includes('crore')) {
                    offerPriceNum = offerPriceNum * 10000000;
                }

                if (devPrice > 0 && offerPriceNum > 0 && devPrice > offerPriceNum) {
                    discountAmount = devPrice - offerPriceNum;
                    if (!property.discountPercentage) {
                        discountPercentageValue = parseFloat(((discountAmount / devPrice) * 100).toFixed(2));
                    }
                }
            }

            // Format prices
            const formatPrice = (amount) => {
                if (amount >= 10000000) {
                    return `₹ ${(amount / 10000000).toFixed(2)} Crore`;
                } else if (amount >= 100000) {
                    return `₹ ${(amount / 100000).toFixed(2)} Lakh`;
                } else {
                    return `₹ ${amount.toLocaleString('en-IN')}`;
                }
            };

            return {
                id: property._id,
                projectId: property.projectId,
                projectName: property.projectName,
                location: property.location,
                latitude: property.latitude || null,
                longitude: property.longitude || null,
                // Main image
                image: coverImage,
                // Last Day to Join banner
                lastDayToJoin: lastDayToJoin ? `Last Day to join ${lastDayToJoin}` : null,
                // Group Size
                groupSize: property.minGroupMembers || 0,
                groupSizeFormatted: `${String(property.minGroupMembers || 0).padStart(2, '0')} Members`,
                // Opening (available units) - calculated from subConfigurations
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
                // Pricing
                targetPrice: {
                    value: minPrice,
                    formatted: formatPrice(minPrice)
                },
                developerPrice: {
                    value: maxPrice,
                    formatted: formatPrice(maxPrice)
                },
                // Discount information
                discount: discountAmount > 0 ? {
                    amount: discountAmount,
                    amountFormatted: formatPrice(discountAmount),
                    percentage: discountPercentageValue,
                    percentageFormatted: property.discountPercentage || `${discountPercentageValue.toFixed(2)}%`,
                    message: discountPercentageValue > 0 ? `Get upto ${discountPercentageValue}% discount on this property` : null,
                    // Format like "Up to 63.20 Lakh" for UI
                    displayText: `Up to ${formatPrice(discountAmount)}`
                } : null,
                // Offer Price and Discount Percentage
                offerPrice: property.offerPrice || null,
                discountPercentage: property.discountPercentage || "00.00%",
                // Configurations
                configurations: unitTypes,
                configurationsFormatted: unitTypes.join(', '),
                // Possession status
                possessionStatus: property.possessionStatus || 'N/A',
                // Developer
                developer: developerInfo?.developerName || 'N/A',
                // Lead count (for ranking)
                leadCount: leadCount,
                // Additional info for UI
                reraId: property.reraId,
                description: property.description,
                // Relationship Manager for call button
                relationshipManager: property.relationshipManager || null
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

        // BHK filter
        if (bhk) {
            propertyFilter["configurations"] = { $elemMatch: { unitType: { $regex: bhk, $options: "i" } } };
        }

        // Property type filter (Duplex, Apartment, etc.) - can be in configurations or project name
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

        // Apply price range filter if provided
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

        // Sort based on sortBy parameter
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

        // Apply pagination
        const total = allProperties.length;
        const paginatedProperties = allProperties.slice(skip, skip + limit);

        // Get all unique developer IDs and fetch them in one query
        const developerIds = [...new Set(paginatedProperties.map(item => {
            const dev = item.developer;
            if (!dev) return null;
            return dev._id ? dev._id.toString() : dev.toString();
        }).filter(Boolean))];

        const developers = await Developer.find({ _id: { $in: developerIds } })
            .select('_id developerName')
            .lean();
        const developerMap = new Map(developers.map(dev => [dev._id.toString(), dev]));

        // Format properties for UI cards (matching image format)
        const formattedProperties = paginatedProperties.map((property) => {
            const leadCount = property.leadCount || 0;

            // Get developer info
            const developerId = property.developer?._id
                ? property.developer._id.toString()
                : (property.developer?.toString() || property.developer);
            const developerInfo = developerMap.get(developerId);

            // Calculate price ranges
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
            const unitTypes = [...new Set(property.configurations?.map(config => config.unitType).filter(Boolean) || [])];

            // Get cover image
            const coverImage = property.images?.find(img => img.isCover)?.url || property.images?.[0]?.url || null;

            // Format possession date for "Last Day to join" banner
            let lastDayToJoin = null;
            if (property.possessionDate) {
                const date = new Date(property.possessionDate);
                lastDayToJoin = date.toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric'
                });
            }

            // Calculate discount (difference between developer price and offer price)
            let discountAmount = 0;
            let discountPercentageValue = 0;
            let offerPriceNum = 0;

            // Use stored discountPercentage from model
            if (property.discountPercentage) {
                discountPercentageValue = parseFloat(property.discountPercentage.replace('%', '')) || 0;
            }

            if (property.developerPrice && property.offerPrice) {
                let devPrice = parseFloat(property.developerPrice.replace(/[₹,\s]/g, '')) || 0;
                offerPriceNum = parseFloat(property.offerPrice.replace(/[₹,\s]/g, '')) || 0;

                // Handle currency conversion for developer price
                const devPriceStr = property.developerPrice.toLowerCase();
                if (devPriceStr.includes('lakh') || devPriceStr.includes('l')) {
                    devPrice = devPrice * 100000;
                } else if (devPriceStr.includes('cr') || devPriceStr.includes('crore')) {
                    devPrice = devPrice * 10000000;
                }

                // Handle currency conversion for offer price
                const offerPriceStr = property.offerPrice.toLowerCase();
                if (offerPriceStr.includes('lakh') || offerPriceStr.includes('l')) {
                    offerPriceNum = offerPriceNum * 100000;
                } else if (offerPriceStr.includes('cr') || offerPriceStr.includes('crore')) {
                    offerPriceNum = offerPriceNum * 10000000;
                }

                if (devPrice > 0 && offerPriceNum > 0 && devPrice > offerPriceNum) {
                    discountAmount = devPrice - offerPriceNum;
                    if (!property.discountPercentage) {
                        discountPercentageValue = parseFloat(((discountAmount / devPrice) * 100).toFixed(2));
                    }
                }
            }

            // Format prices
            const formatPrice = (amount) => {
                if (amount >= 10000000) {
                    return `₹ ${(amount / 10000000).toFixed(2)} Crore`;
                } else if (amount >= 100000) {
                    return `₹ ${(amount / 100000).toFixed(2)} Lakh`;
                } else {
                    return `₹ ${amount.toLocaleString('en-IN')}`;
                }
            };

            return {
                id: property._id,
                projectId: property.projectId,
                projectName: property.projectName,
                location: property.location,
                latitude: property.latitude || null,
                longitude: property.longitude || null,
                // Main image
                image: coverImage,
                // Last Day to Join banner
                lastDayToJoin: lastDayToJoin ? `Last Day to join ${lastDayToJoin}` : null,
                // Group Size
                groupSize: property.minGroupMembers || 0,
                groupSizeFormatted: `${String(property.minGroupMembers || 0).padStart(2, '0')} Members`,
                // Opening (available units)
                openingLeft: property.configurations?.filter(c => c.availabilityStatus === 'Available').length || 0,
                openingFormatted: `${String(property.configurations?.filter(c => c.availabilityStatus === 'Available').length || 0).padStart(2, '0')} Left`,
                // Pricing
                targetPrice: {
                    value: minPrice,
                    formatted: formatPrice(minPrice)
                },
                developerPrice: {
                    value: maxPrice,
                    formatted: formatPrice(maxPrice)
                },
                // Discount information
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

        const userId = req.user?.userId;
        let searchHistoryData = null;

        if (userId && (searchText || city)) {
            try {
                const trimmedSearchQuery = searchText?.trim() || '';
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
                    // Update the timestamp to reflect recent search
                    await UserSearchHistory.updateOne(
                        { _id: existingSearch._id },
                        { updatedAt: new Date() }
                    );
                } else {
                    // Save new search history
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
                // Don't fail the search if history save fails
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
        const locations = await Property.aggregate([
            { $match: { isStatus: true } },

            {
                $group: {
                    _id: "$location",
                    propertyCount: { $sum: 1 }
                }
            },

            { $sort: { propertyCount: -1 } },

            {
                $project: {
                    _id: 0,
                    location: "$_id",
                    propertyCount: 1
                }
            }
        ]);

        const uniqueLocations = locations.map(item => item.location).filter(Boolean);

        logInfo('Locations list fetched', {
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

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid property ID" });
        }

        // Find property by ID with all details - optimize with lean()
        const property = await Property.findById(id)
            .populate('developer', 'developerName description city establishedYear totalProjects logo website sourcingManager')
            .populate('relationshipManager', 'name email phone')
            .populate('leadDistributionAgents', 'name email phone')
            .lean();

        if (!property) {
            logInfo('Property not found', { propertyId: id });
            return res.status(404).json({ success: false, message: "Property not found" });
        }

        // Calculate price ranges from configurations
        // Helper to parse price (handles both number and string for legacy support)
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

        // Calculate area ranges from subConfigurations
        const areas = [];
        if (property.configurations && Array.isArray(property.configurations)) {
            property.configurations.forEach(config => {
                if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
                    config.subConfigurations.forEach(subConfig => {
                        const carpetArea = parseFloat(subConfig.carpetArea?.replace(/[sqft,\s]/gi, '') || '0');
                        if (carpetArea > 0) areas.push(carpetArea);
                    });
                } else {
                    // Legacy format
                    const carpetArea = parseFloat(config.carpetArea?.replace(/[sqft,\s]/gi, '') || '0');
                    if (carpetArea > 0) areas.push(carpetArea);
                }
            });
        }

        const minArea = areas.length > 0 ? Math.min(...areas) : 0;
        const maxArea = areas.length > 0 ? Math.max(...areas) : 0;

        // Get unique BHK types
        const unitTypes = [...new Set(property.configurations.map(config => config.unitType).filter(Boolean))];

        // Get main image and thumbnails
        const sortedImages = property.images?.sort((a, b) => {
            if (a.isCover) return -1;
            if (b.isCover) return 1;
            return (a.order || 0) - (b.order || 0);
        }) || [];

        const mainImage = sortedImages[0]?.url || null;
        const thumbnails = sortedImages.slice(1, 5).map(img => img.url);

        // Format possession date
        let possessionDateFormatted = null;
        if (property.possessionDate) {
            const date = new Date(property.possessionDate);
            possessionDateFormatted = date.toLocaleDateString('en-IN', {
                month: 'long',
                year: 'numeric'
            });
        }

        // Format prices
        const formatPrice = (amount) => {
            if (amount >= 10000000) {
                return `₹ ${(amount / 10000000).toFixed(2)} Crore`;
            } else if (amount >= 100000) {
                return `₹ ${(amount / 100000).toFixed(2)} Lakh`;
            } else {
                return `₹ ${amount.toLocaleString('en-IN')}`;
            }
        };

        // Format property details
        const propertyDetails = {
            id: property._id,
            projectId: property.projectId,
            projectName: property.projectName,
            location: property.location,
            latitude: property.latitude || null,
            longitude: property.longitude || null,
            // Parse location into components (area, city, state)
            locationDetails: {
                full: property.location,
                // Try to extract area, city, state from location string
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
            // Property Details
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
                propertyType: 'Residential' // Can be made dynamic if needed
            },
            description: property.description || '',
            rating: 5, // Default rating, can be calculated from reviews if available
            highlights: property.highlights || [],
            amenities: property.amenities || [],
            // Images
            images: {
                main: mainImage,
                thumbnails: thumbnails,
                all: sortedImages.map(img => ({
                    url: img.url,
                    isCover: img.isCover,
                    order: img.order
                }))
            },
            // Layout Plans - extracted from subConfigurations
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
                // Legacy support
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
            // Neighborhood / Connectivity
            neighborhood: {
                connectivity: convertConnectivityToObject(property.connectivity),
                mapCoordinates: (() => {
                    // Get first available coordinate from any connectivity category
                    const conn = convertConnectivityToObject(property.connectivity);
                    if (conn) {
                        // Try to get first coordinate from any category
                        for (const category in conn) {
                            if (Array.isArray(conn[category]) && conn[category].length > 0) {
                                return conn[category][0] || null;
                            }
                        }
                    }
                    return null;
                })()
            },
            // Developer Information
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
            // Relationship Manager
            relationshipManager: property.relationshipManager ? {
                id: property.relationshipManager._id,
                name: property.relationshipManager.name,
                email: property.relationshipManager.email,
                phone: property.relationshipManager.phone
            } : null,
            // Full configurations for detailed view (with subConfigurations)
            configurations: property.configurations ? property.configurations.map(config => {
                if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
                    // New format: return with subConfigurations
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
                    // Legacy format: convert to new format
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
            // Additional metadata
            projectSize: property.projectSize,
            landParcel: property.landParcel,
            minGroupMembers: property.minGroupMembers,
            createdAt: property.createdAt,
            updatedAt: property.updatedAt
        };

        // Group Buy Section - Get members who joined the group
        const groupBuyData = await getGroupBuyDetails(id, property.minGroupMembers || 0);

        // Add group buy data to property details
        propertyDetails.groupBuy = groupBuyData;

        // Find similar projects based on budget and location
        const similarProjects = await findSimilarProjects(property, minPrice, maxPrice);

        // Add to view history if user is authenticated (token present)
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
                    // Update lastViewedAt to show in latest
                    await UserPropertyActivity.updateOne(
                        { _id: existing._id },
                        { lastViewedAt: new Date() }
                    );
                    logInfo('Property view updated in history', { userId, propertyId });
                } else {
                    // Create new view entry
                    await UserPropertyActivity.create({
                        userId,
                        propertyId,
                        activityType: "viewed",
                        lastViewedAt: new Date()
                    });
                    logInfo('Property view added to history', { userId, propertyId });
                }
            } catch (viewError) {
                // Log error but don't fail the request
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

            // Nearby Budget Matching (50% weight)
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

            // Exact location match (highest priority)
            if (propLocation === currentLocation) {
                score += 50;
                locationMatch = true;
            }
            // Same area match
            else if (currentArea && propArea && propArea === currentArea) {
                score += 40;
                locationMatch = true;
            }
            // Same city match
            else if (currentCity && propCity && propCity === currentCity) {
                score += 35;
                locationMatch = true;
            }
            // Same state match
            else if (currentState && propState && propState === currentState) {
                score += 20;
            }
            // Partial location keyword match (area or city contains keywords)
            else {
                const matchingKeywords = locationParts.filter(part => {
                    if (part.length < 3) return false;
                    return propLocation.includes(part);
                });

                if (matchingKeywords.length > 0) {
                    // Give score based on number of matching keywords
                    score += (matchingKeywords.length / locationParts.length) * 30;
                    if (matchingKeywords.length >= 2) {
                        locationMatch = true;
                    }
                }
            }

            // Bonus: Same developer (10% bonus, but only if budget or location matches)
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

        // Filter: Must have at least budget match OR location match, and minimum score of 30
        // Prioritize properties that match both criteria
        const topSimilar = scoredProperties
            .filter(item => {
                // Must have either budget match or location match
                return (item.budgetMatch || item.locationMatch) && item.score >= 30;
            })
            .sort((a, b) => {
                // First sort by: both matches > single match
                const aBothMatches = a.budgetMatch && a.locationMatch ? 1 : 0;
                const bBothMatches = b.budgetMatch && b.locationMatch ? 1 : 0;
                if (aBothMatches !== bBothMatches) {
                    return bBothMatches - aBothMatches;
                }
                // Then by score
                return b.score - a.score;
            })
            .slice(0, 3)
            .map(item => {
                const prop = item.property;

                // Calculate prices for similar project
                const simPrices = extractPricesFromConfigurations(prop.configurations, prop.developerPrice || '0');

                const simMinPrice = simPrices.length > 0 ? Math.min(...simPrices) : 0;
                const simMaxPrice = simPrices.length > 0 ? Math.max(...simPrices) : 0;

                // Get unit types
                const simUnitTypes = [...new Set(prop.configurations.map(config => config.unitType).filter(Boolean))];

                // Get cover image
                const coverImage = prop.images?.find(img => img.isCover)?.url || prop.images?.[0]?.url || null;

                // Format possession date
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
                    imageUrl: coverImage,
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
        // Get lead details
        const lead = await leadModal.findById(leadId)
            .populate('propertyId', 'relationshipManager leadDistributionAgents projectName projectId')
            .populate('userId', 'name')
            .lean();

        if (!lead || !lead.propertyId) {
            return; // Skip if lead or property not found
        }

        const property = lead.propertyId;
        const leadUser = lead.userId || {};

        // Determine notification recipients (relationship manager and lead distribution agents)
        const recipients = [];

        if (property.relationshipManager) {
            recipients.push(property.relationshipManager);
        }

        if (property.leadDistributionAgents && Array.isArray(property.leadDistributionAgents)) {
            recipients.push(...property.leadDistributionAgents);
        }

        // Remove duplicates
        const uniqueRecipients = [...new Set(recipients.map(r => r.toString()))];

        // Create notifications for each recipient
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
        // Don't throw - notifications are non-critical
    }
};

// @desc    Join Group Buy for a property
// @route   POST /api/home/join-group
// @access  Private (authenticated)
exports.joinGroup = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { propertyId, source = "origin" } = req.body;

        // Validate property
        const property = await Property.findById(propertyId)
            .populate('relationshipManager', 'name email phone')
            .select('relationshipManager projectName')
            .lean();
        if (!property) {
            logInfo('Property not found for join group', { propertyId });
            return res.status(404).json({ success: false, message: "Property not found" });
        }

        // Check if lead already exists for this user and property
        let existingLead = await leadModal.findOne({
            userId,
            propertyId,
            isStatus: true
        }).lean();

        let lead;
        if (existingLead) {
            // Lead already exists - update it
            lead = existingLead;
            logInfo('Lead already exists, using existing lead for join group', {
                leadId: lead._id,
                userId,
                propertyId
            });
        } else {
            // Get IP address
            const ipAddress = getClientIpAddress(req);

            // Create new lead
            lead = await leadModal.create({
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
            logInfo('New lead created for join group', {
                leadId: lead._id,
                userId,
                propertyId
            });
        }

        // Get user details for timeline
        const user = await User.findById(userId).select('name').lean();
        const performedByName = user?.name || 'User';

        // Add timeline activity for join group
        await addTimelineActivity(
            lead._id,
            'join_group',
            userId,
            performedByName,
            `${performedByName} joined the group buy for ${property.projectName}`,
            { propertyId: propertyId.toString(), source }
        );

        // Create notification for join group
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
        const { propertyId, visitDate, visitTime, source = "origin" } = req.body;

        // Validate property - optimize with lean() and select only needed fields
        const property = await Property.findById(propertyId)
            .populate('relationshipManager', 'name email phone')
            .select('relationshipManager projectName')
            .lean();
        if (!property) {
            logInfo('Property not found for visit registration', { propertyId });
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

        // Check if lead already exists for this user and property
        let existingLead = await leadModal.findOne({
            userId,
            propertyId,
            isStatus: true
        }).lean();

        let lead;
        if (existingLead) {
            // Lead already exists - update visit status
            lead = existingLead;
            await leadModal.updateOne(
                { _id: lead._id },
                {
                    visitStatus: 'visited',
                    updatedBy: userId
                }
            );
        } else {
            // Get IP address
            const ipAddress = getClientIpAddress(req);

            // Create new lead
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
                ipAddress: ipAddress
            });
        }

        // Get user details for timeline
        const user = await User.findById(userId).select('name').lean();
        const performedByName = user?.name || 'User';

        // Format visit date/time for description
        const visitDateTime = parsedVisitDate
            ? `${parsedVisitDate.toLocaleDateString('en-IN')} ${visitTime || ''}`.trim()
            : new Date().toLocaleString('en-IN');

        // Add timeline activity for visit
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

        // Create notification for visit
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
        const userId = req.user?.userId; // Optional - user might not be logged in

        // Validate required fields
        if (!name || !email || !phone) {
            return res.status(400).json({
                success: false,
                message: "Name, email, and phone are required"
            });
        }

        // Validate phone number (should be 10 digits)
        if (phone.length !== 10 || !/^\d+$/.test(phone)) {
            return res.status(400).json({
                success: false,
                message: "Phone number must be 10 digits"
            });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Invalid email format"
            });
        }

        let user;
        let leadUserId;

        // If user is logged in, use existing user
        if (userId) {
            user = await User.findById(userId).select('name email phone').lean();
            if (user) {
                leadUserId = userId;
            }
        }

        // If user is not logged in, check if user exists with this email/phone
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
                // Create a new user for this contact
                const RoleModel = require('../models/role');
                const bcrypt = require('bcryptjs');

                // Get default User role
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

                // Create user with a random password (user can reset later)
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

        // Get default relationship manager (first Project Manager or Admin)
        // Reuse Role from above if already required, otherwise require it
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

        // Get IP address
        const ipAddress = getClientIpAddress(req);

        // Create lead without propertyId
        const lead = await leadModal.create({
            userId: leadUserId,
            propertyId: null, // No property for contact us
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

        // Add timeline activity for contact us (if RM exists, otherwise use system)
        if (lead._id) {
            const activityPerformedBy = defaultRM?._id || leadUserId; // Use RM or user as fallback
            const activityPerformedByName = defaultRM?.name || user?.name || 'System';

            await addTimelineActivity(
                lead._id,
                'join_group', // Activity type for contact us
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

        // Build filter - only published blogs
        const filter = {
            isStatus: true,
            isPublished: true
        };

        // Category filter
        if (category) {
            filter.category = { $regex: category, $options: 'i' };
        }

        // Tag filter
        if (tag) {
            filter.tags = { $in: [new RegExp(tag, 'i')] };
        }

        // Search filter
        if (search) {
            filter.$or = [
                { title: { $regex: search, $options: 'i' } },
                { subtitle: { $regex: search, $options: 'i' } },
                { content: { $regex: search, $options: 'i' } },
                { category: { $regex: search, $options: 'i' } },
                { tags: { $in: [new RegExp(search, 'i')] } }
            ];
        }

        // Build sort criteria
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
            .select('title subtitle category author authorName tags bannerImage slug views createdAt')
            .sort(sortCriteria)
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        // Format blogs for homepage
        const formattedBlogs = blogs.map(blog => {
            // Format date (e.g., "12 Jan, 2025")
            const date = new Date(blog.createdAt);
            const formattedDate = date.toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric'
            });

            return {
                _id: blog._id,
                title: blog.title,
                subtitle: blog.subtitle || '',
                category: blog.category || '',
                author: blog.authorName || blog.author?.name || 'Admin',
                authorImage: blog.author?.profileImage || null,
                tags: blog.tags || [],
                bannerImage: blog.bannerImage || null,
                slug: blog.slug,
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
                totalPages: Math.ceil(total / parseInt(limit))
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

        // Determine if it's an ID or slug
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

        // Increment views
        await Blog.findByIdAndUpdate(blog._id, { $inc: { views: 1 } });

        // Format date
        const date = new Date(blog.createdAt);
        const formattedDate = date.toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
        });

        // Format response
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
            views: (blog.views || 0) + 1, // Include the increment
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

        // Validate input
        if (!propertyIds || !Array.isArray(propertyIds)) {
            return res.status(400).json({
                success: false,
                message: 'propertyIds must be an array'
            });
        }

        // Limit to 3 properties for comparison (as per UI)
        if (propertyIds.length === 0 || propertyIds.length > 3) {
            return res.status(400).json({
                success: false,
                message: 'Please provide 1 to 3 property IDs for comparison'
            });
        }

        // Validate all IDs are valid ObjectIds
        const invalidIds = propertyIds.filter(id => !mongoose.Types.ObjectId.isValid(id));
        if (invalidIds.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Invalid property IDs: ${invalidIds.join(', ')}`
            });
        }

        // Fetch all properties in parallel with optimized queries
        const properties = await Property.find({
            _id: { $in: propertyIds },
            isStatus: true
        })
            .populate('developer', 'developerName')
            .populate('relationshipManager', 'name email phone')
            .select('projectName developer location latitude longitude configurations images possessionDate possessionStatus projectId developerPrice offerPrice discountPercentage')
            .lean();

        // Check if all properties were found
        if (properties.length !== propertyIds.length) {
            const foundIds = properties.map(p => p._id.toString());
            const missingIds = propertyIds.filter(id => !foundIds.includes(id));
            return res.status(404).json({
                success: false,
                message: `Properties not found: ${missingIds.join(', ')}`
            });
        }

        // Format properties for comparison
        const formattedProperties = properties.map(property => {
            // Calculate budget range from configurations
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

            // Also check root level developerPrice and offerPrice
            if (property.developerPrice) {
                let devPrice = parseFloat(property.developerPrice.replace(/[₹,\s]/g, '')) || 0;
                if (property.developerPrice.toLowerCase().includes('lakh') || property.developerPrice.toLowerCase().includes('l')) {
                    devPrice = devPrice * 100000;
                } else if (property.developerPrice.toLowerCase().includes('cr') || property.developerPrice.toLowerCase().includes('crore')) {
                    devPrice = devPrice * 10000000;
                }
                if (devPrice > 0) prices.push(devPrice);
            }

            const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
            const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

            // Calculate area range from configurations
            const areas = [];
            if (property.configurations && Array.isArray(property.configurations)) {
                property.configurations.forEach(config => {
                    if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
                        config.subConfigurations.forEach(subConfig => {
                            const carpetArea = parseFloat(subConfig.carpetArea?.replace(/[sqft,\s]/gi, '') || '0');
                            if (carpetArea > 0) areas.push(carpetArea);
                        });
                    } else {
                        // Legacy format
                        const carpetArea = parseFloat(config.carpetArea?.replace(/[sqft,\s]/gi, '') || '0');
                        if (carpetArea > 0) areas.push(carpetArea);
                    }
                });
            }

            const minArea = areas.length > 0 ? Math.min(...areas) : 0;
            const maxArea = areas.length > 0 ? Math.max(...areas) : 0;

            // Get unique BHK types from configurations
            const unitTypes = [...new Set(property.configurations.map(config => config.unitType).filter(Boolean))];

            // Get cover image or first image
            const coverImage = property.images?.find(img => img.isCover)?.url || property.images?.[0]?.url || null;

            // Get floor plan images from subConfigurations
            const floorPlans = [];
            if (property.configurations && Array.isArray(property.configurations)) {
                property.configurations.forEach(config => {
                    if (config.subConfigurations && Array.isArray(config.subConfigurations)) {
                        config.subConfigurations.forEach(subConfig => {
                            if (subConfig.layoutPlanImages && subConfig.layoutPlanImages.length > 0) {
                                subConfig.layoutPlanImages.forEach(imageUrl => {
                                    floorPlans.push({
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
            // Legacy support: also check old layouts array
            if (property.layouts && Array.isArray(property.layouts)) {
                property.layouts.forEach(layout => {
                    floorPlans.push({
                        image: layout.image || layout,
                        unitType: layout.configurationUnitType || null
                    });
                });
            }

            const floorPlansFormatted = floorPlans.map(plan => ({
                image: layout.image,
                unitType: layout.configurationUnitType
            })) || [];

            // Format possession date
            let possessionDateFormatted = null;
            if (property.possessionDate) {
                const date = new Date(property.possessionDate);
                possessionDateFormatted = date.toLocaleDateString('en-IN', {
                    month: 'short',
                    year: 'numeric'
                });
            }

            return {
                id: property._id,
                projectId: property.projectId,
                projectName: property.projectName,
                developer: property.developer?.developerName || 'N/A',
                developerId: property.developer?._id || null,
                location: property.location,
                latitude: property.latitude || null,
                longitude: property.longitude || null,
                propertyType: 'Residential', // Based on UI, can be made dynamic if needed
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
                mainImage: coverImage,
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
                // Include full configurations for detailed view if needed
                fullConfigurations: property.configurations
            };
        });

        logInfo('Properties compared', {
            propertyCount: formattedProperties.length,
            propertyIds: propertyIds
        });

        res.json({
            success: true,
            message: 'Properties fetched for comparison',
            data: formattedProperties,
            count: formattedProperties.length
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

        // Validate inputs
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

        // Convert loan amount to actual number (handle Crores, Lakhs, etc.)
        let principalAmount = parseFloat(loanAmount);

        // If loan amount is in string format with units, parse it
        if (typeof loanAmount === 'string') {
            const amountStr = loanAmount.toLowerCase().trim();
            if (amountStr.includes('crore') || amountStr.includes('cr')) {
                const num = parseFloat(amountStr.replace(/[₹,\s]/g, '').replace(/crore|cr/gi, ''));
                principalAmount = num * 10000000; // 1 Crore = 10,000,000
            } else if (amountStr.includes('lakh') || amountStr.includes('l')) {
                const num = parseFloat(amountStr.replace(/[₹,\s]/g, '').replace(/lakh|l/gi, ''));
                principalAmount = num * 100000; // 1 Lakh = 100,000
            } else {
                principalAmount = parseFloat(amountStr.replace(/[₹,\s]/g, '')) || principalAmount;
            }
        }

        // Convert annual interest rate to monthly rate
        const monthlyRate = parseFloat(rateOfInterest) / 12 / 100;

        // Loan tenure in months
        const tenureMonths = parseInt(loanTenure);

        // Calculate EMI using the formula: EMI = [P × R × (1+R)^N] / [(1+R)^N - 1]
        // Where P = Principal, R = Monthly Rate, N = Tenure in months
        const monthlyEMI = principalAmount * monthlyRate * Math.pow(1 + monthlyRate, tenureMonths) /
            (Math.pow(1 + monthlyRate, tenureMonths) - 1);

        // Calculate total amount payable
        const totalAmountPayable = monthlyEMI * tenureMonths;

        // Calculate total interest
        const totalInterest = totalAmountPayable - principalAmount;

        // Calculate principal and interest components for the first EMI (for pie chart)
        const interestComponent = principalAmount * monthlyRate;
        const principalComponent = monthlyEMI - interestComponent;

        // Format amounts for display
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
            // For pie chart visualization
            emiBreakdown: {
                principal: Math.round(principalComponent),
                interest: Math.round(interestComponent),
                // Percentage for pie chart
                principalPercentage: Math.round((principalComponent / monthlyEMI) * 100),
                interestPercentage: Math.round((interestComponent / monthlyEMI) * 100)
            },
            // Input parameters (for reference)
            input: {
                loanAmount: principalAmount,
                rateOfInterest: parseFloat(rateOfInterest),
                loanTenure: tenureMonths,
                currency: currency
            },
            // Additional calculations
            totalPrincipalPaid: {
                value: principalAmount,
                formatted: formatCurrencySimple(principalAmount)
            },
            // Disclaimer
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
