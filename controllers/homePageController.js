const leadModal = require('../models/leadModal');
const Property = require('../models/property');
const UserPropertyActivity = require('../models/userPropertyActivity');
const UserSearchHistory = require('../models/userSearchHistory');
const Developer = require('../models/developer');
const LeadActivity = require('../models/leadActivity');
const Notification = require('../models/notification');
const Blog = require('../models/blog');
const Category = require('../models/category');
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

const getBookedVisitPropertyIds = async (userId) => {
    if (!userId) return new Set();
    try {
        const userLeads = await leadModal.find({
            userId: userId,
            isStatus: true,
            propertyId: { $exists: true, $ne: null }
        }).select('_id propertyId').lean();

        const leadIds = userLeads.map(lead => lead._id);

        if (leadIds.length === 0) return new Set();

        const visitActivities = await LeadActivity.find({
            leadId: { $in: leadIds },
            activityType: 'visit'
        }).select('leadId').lean();

        const leadToPropertyMap = new Map(
            userLeads.map(lead => [lead._id.toString(), lead.propertyId?.toString()])
        );

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

    const coverImages = images.filter(img => img.isCover === true);
    const otherImages = images.filter(img => !img.isCover || img.isCover === false);

    coverImages.sort((a, b) => (a.order || 0) - (b.order || 0));

    otherImages.sort((a, b) => (a.order || 0) - (b.order || 0));

    const sortedImages = [...coverImages, ...otherImages];

    return sortedImages.map(img => {
        if (typeof img === 'string') {
            return img;
        }
        return img.url || img;
    }).filter(Boolean);
};


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

        const userId = req.user?.userId || null;
        const isAuthenticated = !!userId;

        const favoritePropertyIds = await getFavoritePropertyIds(userId);
        const joinedGroupPropertyIds = await getJoinedGroupPropertyIds(userId);
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

        // Get active leads count for each property in the current page
        const propertyIds = rawData.map(item => item._id);
        const activeLeadsCounts = await leadModal.aggregate([
            {
                $match: {
                    propertyId: { $in: propertyIds },
                    isStatus: true
                }
            },
            {
                $group: {
                    _id: "$propertyId",
                    activeLeadsCount: { $sum: 1 }
                }
            }
        ]);

        const activeLeadsMap = new Map(
            activeLeadsCounts.map(item => [item._id.toString(), item.activeLeadsCount])
        );

        const formattedProperties = rawData
            .filter((item) => {
                // Filter out properties where developer doesn't exist (developer may be deleted)
                const developerId = item.developer?._id
                    ? item.developer._id.toString()
                    : (item.developer?.toString() || item.developer);
                return developerId && developerMap.has(developerId);
            })
            .map((item) => {
                const property = item;
                const leadCount = property.leadCount || 0;
                const propertyIdStr = property._id.toString();
                const activeLeadsCount = activeLeadsMap.get(propertyIdStr) || 0;

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
                    images: images,
                    image: images.length > 0 ? images[0] : null,
                    isFavorite: isFavorite,
                    isJoinGroup: isJoinGroup,
                    isBookVisit: isBookVisit,
                    isAuthenticated: isAuthenticated,
                    lastDayToJoin: lastDayToJoin ? `Last Day to join ${lastDayToJoin}` : null,
                    groupSize: property.minGroupMembers || 0,
                    openingLeft: Math.max(0, (property.minGroupMembers || 0) - activeLeadsCount),
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
                    configurations: property.configurations || [],
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

const parseSearchText = (text = "") => {
    const lower = text.toLowerCase();

    const bhkMatch = text.match(/(\d+(\.\d+)?)\s*bhk/i);
    
    return {
        bhk: bhkMatch ? bhkMatch[1] : null,
        text: lower
            .replace(/(\d+(\.\d+)?)\s*bhk/i, '')
            .replace(/ready to move|ready|under construction/gi, '')
            .trim()
    };
};

function parsePriceFromText(text) {
    if (!text) return {};

    const lower = text.toLowerCase();

    const toNumber = (val, unit) => {
        val = parseFloat(val);
        if (unit.includes('cr')) return val * 10000000;
        if (unit.includes('lakh') || unit.includes('lac')) return val * 100000;
        return val;
    };

    let minPrice = null;
    let maxPrice = null;

    // under / below
    let underMatch = lower.match(/(under|below)\s*(\d+(\.\d+)?)\s*(lakh|lac|cr|crore)/);
    if (underMatch) {
        maxPrice = toNumber(underMatch[2], underMatch[4]);
    }

    // above / over
    let aboveMatch = lower.match(/(above|over)\s*(\d+(\.\d+)?)\s*(lakh|lac|cr|crore)/);
    if (aboveMatch) {
        minPrice = toNumber(aboveMatch[2], aboveMatch[4]);
    }

    // between X and Y
    let betweenMatch = lower.match(
        /between\s*(\d+(\.\d+)?)\s*(lakh|lac|cr|crore)\s*and\s*(\d+(\.\d+)?)\s*(lakh|lac|cr|crore)/
    );
    if (betweenMatch) {
        minPrice = toNumber(betweenMatch[1], betweenMatch[3]);
        maxPrice = toNumber(betweenMatch[4], betweenMatch[6]);
    }

    // min / max
    let minMatch = lower.match(/min\s*(\d+(\.\d+)?)\s*(lakh|lac|cr|crore)/);
    if (minMatch) {
        minPrice = toNumber(minMatch[1], minMatch[3]);
    }

    let maxMatch = lower.match(/max\s*(\d+(\.\d+)?)\s*(lakh|lac|cr|crore)/);
    if (maxMatch) {
        maxPrice = toNumber(maxMatch[1], maxMatch[3]);
    }

    return { minPrice, maxPrice };
}

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
            sortBy = 'leadCount',
            areaMin,
            areaMax,
        } = req.query;

        page = parseInt(page);
        limit = parseInt(limit);
        const skip = (page - 1) * limit;

        const propertyFilter = { isStatus: true };
        const { bhk: parsedBhk, sqft, text } = parseSearchText(searchText);

        const textSearchConditions = [];
        const configSearchConditions = [];
        let developerIds = [];
        const andConditions = [];

        const lowerText = text?.toLowerCase() || '';

        if (city && typeof city === 'string' && city.trim().length > 0) {
            const trimmedCity = city.trim();
            propertyFilter.location = { $regex: new RegExp(trimmedCity, 'i') };
        }

        if (lowerText.includes('under construction')) {
            andConditions.push({
                possessionStatus: { $regex: '^Under Construction$', $options: 'i' }
            });
        }

        if (
            lowerText.includes('ready to move') ||
            lowerText === 'ready'
        ) {
            andConditions.push({
                possessionStatus: { $regex: '^Ready To Move$', $options: 'i' }
            });
        }

        const priceFromText = parsePriceFromText(searchText);

        if (priceFromText.minPrice) {
            priceMin = priceFromText.minPrice;
        }

        if (priceFromText.maxPrice) {
            priceMax = priceFromText.maxPrice;
        }

        const hasSearchText = typeof text === 'string' && text.trim().length > 0 && !sqft && !parsedBhk;

        if (hasSearchText) {
            const regex = { $regex: text.trim(), $options: 'i' };

            const developers = await Developer.find({
                developerName: regex
            }).select('_id').lean();

            const orConditions = [
                { projectName: regex },
                { locality: regex },
                { location: regex },
                { state: regex }
            ];

            if (developers.length > 0) {
                developerIds = developers.map(d => d._id); // 🔥 YAHI MISSING THA

                orConditions.push({
                    developer: { $in: developerIds }
                });
            }
            andConditions.push({ $or: orConditions });
        }

        if (parsedBhk || sqft) {
            const configMatch = {};

            if (parsedBhk) {
                configMatch.unitType = {
                    $regex: new RegExp(`${parsedBhk}\\s*BHK`, 'i')
                };
            }

            if (Object.keys(configMatch).length > 0) {
                configSearchConditions.push({
                    configurations: { $elemMatch: configMatch }
                });
            }
        }

        if (textSearchConditions.length > 0) {
            andConditions.push({ $or: textSearchConditions });
        }

        if (configSearchConditions.length > 0) {
            andConditions.push(...configSearchConditions);
        }

        if (developerIds.length > 0) {
            andConditions.push({
                developer: { $in: developerIds }
            });
        }

        if (andConditions.length > 0) {
            propertyFilter.$and = andConditions;
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
            if (typeof priceStr === 'number') {
                return priceStr;
            }

            if (typeof priceStr !== 'string') {
                return 0;
            }

            let priceNum = parseFloat(priceStr.replace(/[₹,\s]/g, '')) || 0;
            const priceStrLower = priceStr.toLowerCase();

            if (priceStrLower.includes('lakh') || priceStrLower.includes('lac') || priceStrLower.includes('l')) {
                priceNum = priceNum * 100000;
            }
            else if (priceStrLower.includes('cr') || priceStrLower.includes('crore')) {
                priceNum = priceNum * 10000000;
            }
            return priceNum;
        };

        // Apply price range filter (in rupees) on configuration / developer / offer prices
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

                return (minPrice >= minPriceFilter && minPrice <= maxPriceFilter) ||
                    (maxPrice >= minPriceFilter && maxPrice <= maxPriceFilter) ||
                    (minPrice <= minPriceFilter && maxPrice >= maxPriceFilter);
            });
        }

        const minArea = sqft
        ? sqft - 50
        : areaMin
          ? parseInt(areaMin)
          : null;
      
      const maxArea = sqft
        ? sqft + 50
        : areaMax
          ? parseInt(areaMax)
          : null;
      
      if (minArea || maxArea) {
        allProperties = allProperties.filter(property => {
          const areas = [];
      
          if (Array.isArray(property.configurations)) {
            property.configurations.forEach(config => {
              if (Array.isArray(config.subConfigurations)) {
                config.subConfigurations.forEach(sub => {
                  const area = parseFloat(
                    sub.carpetArea?.replace(/[^\d.]/g, '') || '0'
                  );
                  if (area > 0) areas.push(area);
                });
              } else if (config.carpetArea) {
                const area = parseFloat(
                  config.carpetArea.replace(/[^\d.]/g, '') || '0'
                );
                if (area > 0) areas.push(area);
              }
            });
          }
      
          if (!areas.length) return false;
      
          return areas.some(area => {
            if (minArea && maxArea) return area >= minArea && area <= maxArea;
            if (minArea) return area >= minArea;
            if (maxArea) return area <= maxArea;
            return true;
          });
        });
      }

        if (sortBy === 'newAdded') {
            allProperties.sort((a, b) => {
                const dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
                const dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
                return dateB - dateA;
            });
        } else if (sortBy === 'oldest') {
            allProperties.sort((a, b) => {
                const dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
                const dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
                return dateA - dateB;
            });
        }
        else if (sortBy === 'priceLow' || sortBy === 'priceLowToHigh' || sortBy === 'lowToHigh') {
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
        } else if (sortBy === 'priceHigh' || sortBy === 'priceHighToLow' || sortBy === 'highToLow') {
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

        const userId = req.user?.userId || null;
        const isAuthenticated = !!userId;

        const favoritePropertyIds = await getFavoritePropertyIds(userId);
        const joinedGroupPropertyIds = await getJoinedGroupPropertyIds(userId);
        const bookedVisitPropertyIds = await getBookedVisitPropertyIds(userId);

        const propertyIds = paginatedProperties.map(item => item._id);
        const activeLeadsCounts = await leadModal.aggregate([
            {
                $match: {
                    propertyId: { $in: propertyIds },
                    isStatus: true
                }
            },
            {
                $group: {
                    _id: "$propertyId",
                    activeLeadsCount: { $sum: 1 }
                }
            }
        ]);

        const activeLeadsMap = new Map(
            activeLeadsCounts.map(item => [item._id.toString(), item.activeLeadsCount])
        );

        const developerIdsForMapping = [...new Set(paginatedProperties.map(item => {
            const dev = item.developer;
            if (!dev) return null;
            return dev._id ? dev._id.toString() : dev.toString();
        }).filter(Boolean))];

        const developers = await Developer.find({ _id: { $in: developerIdsForMapping } })
            .select('_id developerName')
            .lean();
        const developerMap = new Map(developers.map(dev => [dev._id.toString(), dev]));

        const formattedProperties = paginatedProperties
            .filter((property) => {
                // Filter out properties where developer doesn't exist (developer may be deleted)
                const developerId = property.developer?._id
                    ? property.developer._id.toString()
                    : (property.developer?.toString() || property.developer);
                return developerId && developerMap.has(developerId);
            })
            .map((property) => {
                const leadCount = property.leadCount || 0;
                const propertyIdStr = property._id.toString();
                const activeLeadsCount = activeLeadsMap.get(propertyIdStr) || 0;

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
                    images: images,
                    image: images.length > 0 ? images[0] : null,
                    isFavorite: isFavorite,
                    isJoinGroup: isJoinGroup,
                    isBookVisit: isBookVisit,
                    isAuthenticated: isAuthenticated,
                    lastDayToJoin: lastDayToJoin ? `Last Day to join ${lastDayToJoin}` : null,
                    groupSize: property.minGroupMembers || 0,
                    openingLeft: Math.max(0, (property.minGroupMembers || 0) - activeLeadsCount),
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
                bhk: parsedBhk || bhk || null,
                sqft: sqft || null,
                developer: developerIds.length > 0 ? developerIds : null,
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
// Helper function to extract locality from full address
const extractLocality = (fullAddress) => {
    if (!fullAddress || typeof fullAddress !== 'string') {
        return null;
    }

    const parts = fullAddress.split(',').map(part => part.trim()).filter(Boolean);

    if (parts.length === 0) {
        return null;
    }

    if (parts.length === 1) {
        return parts[0];
    }

    const propertyNameKeywords = ['residency', 'villa', 'tower', 'apartments', 'complex', 'society', 'park', 'heights', 'enclave', 'estate', 'plaza', 'mall', 'center', 'centre'];

    const firstPart = parts[0].toLowerCase();
    const isStreetNumber = /^\d+$/.test(parts[0]);
    const isPropertyName = propertyNameKeywords.some(keyword => firstPart.includes(keyword));

    if (isStreetNumber && parts.length > 1) {
        return parts[1];
    }

    if (isPropertyName && parts.length > 1) {
        return parts[1];
    }


    if (/^\d+/.test(parts[0]) && parts.length > 1) {
        return parts[1];
    }

    return parts[0];
};

exports.getLocations = async (req, res, next) => {
    try {
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

        const locationsWithLocality = locations.map(item => {
            const locality = extractLocality(item.location);
            return {
                ...item,
                location: locality || item.location,
                originalLocation: item.location
            };
        }).filter(item => item.location);


        const localityMap = new Map();
        locationsWithLocality.forEach(item => {
            const locality = item.location;
            if (localityMap.has(locality)) {

                localityMap.set(locality, {
                    location: locality,
                    propertyCount: localityMap.get(locality).propertyCount + item.propertyCount
                });
            } else {
                localityMap.set(locality, {
                    location: locality,
                    propertyCount: item.propertyCount
                });
            }
        });


        const uniqueLocations = Array.from(localityMap.values())
            .sort((a, b) => b.propertyCount - a.propertyCount)
            .map(item => item.location);

        logInfo('Top 7 locations fetched by lead count (locality only)', {
            totalLocations: uniqueLocations.length
        });

        res.json({
            success: true,
            message: "Locations fetched successfully",
            data: {
                locations: uniqueLocations,
                locationsWithCount: Array.from(localityMap.values()),
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

        if (!property.isStatus) {
            logInfo('Property is inactive', { propertyId: id });
            return res.status(404).json({ success: false, message: "Property not found" });
        }

        if (!property.developer) {
            logInfo('Property developer not found (developer may be deleted)', { propertyId: id });
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

        const userId = req.user?.userId || null;
        const isAuthenticated = !!userId;

        const favoritePropertyIds = await getFavoritePropertyIds(userId);
        const joinedGroupPropertyIds = await getJoinedGroupPropertyIds(userId);
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
                units: property.totalUnits || 0,
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
            images: images,
            image: mainImage,
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
                const parsePriceForDiscount = (price) => {
                    if (!price) return 0;
                    if (typeof price === 'number') return price;
                    let priceNum = parseFloat(price.toString().replace(/[₹,\s]/g, '')) || 0;
                    const priceStrLower = price.toString().toLowerCase();
                    if (priceStrLower.includes('lakh') || priceStrLower.includes('l')) {
                        priceNum *= 100000;
                    } else if (priceStrLower.includes('cr') || priceStrLower.includes('crore')) {
                        priceNum *= 10000000;
                    }
                    return priceNum;
                };
                const devPriceNum = parsePriceForDiscount(prop.developerPrice);
                const offerPriceNum = parsePriceForDiscount(prop.offerPrice);
                let discountAmount = 0;
                let discountPercentageValue = 0;
                if (prop.discountPercentage) {
                    discountPercentageValue = parseFloat(prop.discountPercentage.replace('%', '')) || 0;
                    if (devPriceNum > 0 && discountPercentageValue > 0) {
                        discountAmount = (devPriceNum * discountPercentageValue) / 100;
                    }
                } else if (devPriceNum > 0 && offerPriceNum > 0 && devPriceNum > offerPriceNum) {
                    discountAmount = devPriceNum - offerPriceNum;
                    discountPercentageValue = parseFloat(((discountAmount / devPriceNum) * 100).toFixed(2));
                }
                const formatPrice = (amount) => {
                    if (!amount) return '₹ 0';
                    if (amount >= 10000000) return `₹ ${(amount / 10000000).toFixed(2)} Crore`;
                    if (amount >= 100000) return `₹ ${(amount / 100000).toFixed(2)} Lakh`;
                    return `₹ ${amount.toLocaleString('en-IN')}`;
                };
                const simPrices = extractPricesFromConfigurations(prop.configurations, prop.developerPrice || '0');
                const simMinPrice = simPrices.length > 0 ? Math.min(...simPrices) : 0;
                const simMaxPrice = simPrices.length > 0 ? Math.max(...simPrices) : 0;
                const simUnitTypes = [...new Set(prop.configurations.map(config => config.unitType).filter(Boolean))];
                const simImages = formatPropertyImages(prop.images);
                let lastDayToJoin = null;
                if (prop.possessionDate) {
                    const d = new Date(prop.possessionDate);
                    lastDayToJoin = d.toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                    });
                }
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
                    lastDayToJoin: lastDayToJoin ? `Last Day to join ${lastDayToJoin}` : null,
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
                    discount: discountAmount > 0 && discountPercentageValue > 0 ? {
                        amount: discountAmount,
                        amountFormatted: formatPrice(discountAmount),
                        percentage: discountPercentageValue,
                        percentageFormatted: `${discountPercentageValue.toFixed(2)}%`,
                        message: `Get upto ${discountPercentageValue.toFixed(2)}% discount on this property`,
                        displayText: `Up to ${formatPrice(discountAmount)}`
                    } : null,                                           
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
        } else {
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
                ipAddress: ipAddress
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
                }
            );
        } else {
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
                ipAddress: ipAddress
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
        const { firstName, phoneNumber, email, notes } = req.body;
        const userId = req.user?.userId;

        if (!firstName || !phoneNumber || !email || !notes) {
            return res.status(400).json({
                success: false,
                message: "First Name, Phone Number, Email ID, and Notes are required"
            });
        }

        const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanPhone.length !== 10 || !/^\d+$/.test(cleanPhone)) {
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
            user = await User.findById(userId).select('name firstName lastName email phoneNumber phone').lean();
            if (user) {
                leadUserId = userId;
            }
        }

        if (!leadUserId) {
            user = await User.findOne({
                $or: [
                    { email: email.toLowerCase().trim() },
                    { phoneNumber: cleanPhone },
                    { phone: cleanPhone }
                ]
            }).select('_id name firstName lastName email phoneNumber phone').lean();

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
                    firstName: firstName.trim(),
                    name: firstName.trim(),
                    email: email.toLowerCase().trim(),
                    phoneNumber: cleanPhone,
                    phone: cleanPhone,
                    countryCode: '+91',
                    password: hashedPassword,
                    role: defaultRole._id
                });

                leadUserId = newUser._id;
                user = {
                    _id: newUser._id,
                    name: newUser.name,
                    firstName: newUser.firstName,
                    email: newUser.email,
                    phoneNumber: newUser.phoneNumber,
                    phone: newUser.phone
                };
            }
        }

        const RoleModel = require('../models/role');
        const projectManagerRole = await RoleModel.findOne({ name: 'Project Manager' }).select('_id').lean();
        const adminRole = await RoleModel.findOne({ name: 'Admin' }).select('_id').lean();
        const superAdminRole = await RoleModel.findOne({ name: 'Super Admin' }).select('_id').lean();

        let defaultRM = null;
        if (projectManagerRole) {
            defaultRM = await User.findOne({ role: projectManagerRole._id })
                .select('_id name email phone phoneNumber')
                .lean();
        }

        if (!defaultRM && adminRole) {
            defaultRM = await User.findOne({ role: adminRole._id })
                .select('_id name email phone phoneNumber')
                .lean();
        }

        if (!defaultRM && superAdminRole) {
            defaultRM = await User.findOne({ role: superAdminRole._id })
                .select('_id name email phone phoneNumber')
                .lean();
        }

        const ipAddress = getClientIpAddress(req);

        const lead = await leadModal.create({
            userId: leadUserId,
            propertyId: null,
            relationshipManagerId: defaultRM?._id || null,
            rmEmail: defaultRM?.email || '',
            rmPhone: defaultRM?.phone || defaultRM?.phoneNumber || '',
            message: notes || '',
            isStatus: true,
            source: "Contact Us",
            status: 'lead_received',
            visitStatus: 'not_visited',
            ipAddress: ipAddress
        });

        if (lead._id) {
            const activityPerformedBy = defaultRM?._id || leadUserId;
            const activityPerformedByName = defaultRM?.name || user?.name || firstName || 'System';

            await addTimelineActivity(
                lead._id,
                'lead_received',
                activityPerformedBy,
                activityPerformedByName,
                `${firstName} contacted us via Contact Us form${notes ? `: ${notes}` : ''}`,
                {
                    source: 'Contact Us',
                    firstName,
                    email,
                    phoneNumber: cleanPhone,
                    notes: notes || ''
                }
            );
        }

        logInfo('Contact Us lead created', {
            leadId: lead._id,
            userId: leadUserId,
            firstName,
            email,
            phoneNumber: cleanPhone,
            source: 'Contact Us',
            hasProperty: false
        });

        res.status(201).json({
            success: true,
            message: "Thank you for contacting us! We'll reach out within 24 hours.",
            data: {
                leadId: lead._id,
                userId: leadUserId,
                firstName: user?.firstName || firstName,
                name: user?.name || firstName,
                email: user?.email || email,
                phoneNumber: user?.phoneNumber || user?.phone || cleanPhone
            }
        });

    } catch (error) {
        logError('Error creating contact us lead', error, {
            email: req.body.email,
            phoneNumber: req.body.phoneNumber,
            firstName: req.body.firstName
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
            categoryId,
            categoryName,
            category,
            tag,
            search,
            sortBy = 'newest'
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const filter = { isStatus: true, isPublished: true };

        // Ensure we only show blogs under active categories
        const activeCategoryIds = await Category.find({ isActive: true })
            .select('_id')
            .lean();
        const activeCategoryIdList = activeCategoryIds.map(cat => cat._id);
        if (activeCategoryIdList.length === 0) {
            return res.json({
                success: true,
                message: 'Blogs fetched successfully',
                data: [],
                pagination: {
                    total: 0,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: 0,
                    hasMore: false
                }
            });
        }
        filter.category = { $in: activeCategoryIdList };

        const providedCategory = categoryId || categoryName || category;
        if (providedCategory) {
            let resolvedCategory = null;
            if (mongoose.Types.ObjectId.isValid(providedCategory)) {
                resolvedCategory = await Category.findOne({
                    _id: providedCategory,
                    isActive: true
                }).select('_id');
            } else {
                resolvedCategory = await Category.findOne({
                    nameLower: providedCategory.toLowerCase(),
                    isActive: true
                }).select('_id');
            }

            if (!resolvedCategory) {
                return res.json({
                    success: true,
                    message: 'Blogs fetched successfully',
                    data: [],
                    pagination: {
                        total: 0,
                        page: parseInt(page),
                        limit: parseInt(limit),
                        totalPages: 0,
                        hasMore: false
                    }
                });
            }

            filter.category = resolvedCategory._id;
        }

        if (tag) {
            filter.tags = { $in: [new RegExp(tag, 'i')] };
        }

        if (search) {
            const matchedCategories = await Category.find({
                name: { $regex: search, $options: 'i' },
                isActive: true
            }).select('_id').lean();
            const categoryMatches = matchedCategories.map(c => c._id);

            filter.$or = [
                { title: { $regex: search, $options: 'i' } },
                { subtitle: { $regex: search, $options: 'i' } },
                { content: { $regex: search, $options: 'i' } },
                { tags: { $in: [new RegExp(search, 'i')] } }
            ];

            if (categoryMatches.length > 0) {
                filter.$or.push({ category: { $in: categoryMatches } });
            }
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

        let blogs = [];
        let total = 0;

        const baseQuery = Blog.find(filter)
            .populate('author', 'name profileImage')
            .populate({
                path: 'category',
                select: 'name isActive'
            })
            .select('title subtitle category author authorName tags bannerImage slug views createdAt content');

        if (sortBy === 'category') {
            blogs = await baseQuery.sort({ createdAt: -1 }).lean();
            blogs = blogs.filter(blog => blog.category); // ensure active category present
            blogs.sort((a, b) => {
                const nameA = a.category?.name || '';
                const nameB = b.category?.name || '';
                return nameA.localeCompare(nameB);
            });
            total = blogs.length;
            blogs = blogs.slice(skip, skip + parseInt(limit));
        } else {
            total = await Blog.countDocuments(filter);
            blogs = await baseQuery
                .sort(sortCriteria)
                .skip(skip)
                .limit(parseInt(limit))
                .lean();
        }

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
                category: blog.category ? {
                    id: blog.category._id,
                    name: blog.category.name
                } : null,
                createdAt: blog.createdAt
            };
        });

        if (sortBy === 'category') {
            formattedBlogs.sort((a, b) => {
                const nameA = a.category?.name || '';
                const nameB = b.category?.name || '';
                return nameA.localeCompare(nameB);
            });
        }

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

// ===================== GET ACTIVE BLOG CATEGORIES (Homepage) =====================
// @desc    Get all active blog categories for filters
// @route   GET /api/home/blog-categories
// @access  Public
exports.getBlogCategories = async (req, res, next) => {
    try {
        const { includeCounts = 'false' } = req.query;

        let countsMap = new Map();
        if (includeCounts === 'true') {
            const counts = await Blog.aggregate([
                {
                    $match: {
                        isStatus: true,
                        isPublished: true,
                        category: { $exists: true, $ne: null }
                    }
                },
                {
                    $group: {
                        _id: '$category',
                        count: { $sum: 1 }
                    }
                }
            ]);
            countsMap = new Map(counts.map(item => [item._id.toString(), item.count]));
        }

        const categories = await Category.find({ isActive: true })
            .sort({ nameLower: 1 })
            .select('name isActive')
            .lean();

        const data = categories.map(cat => ({
            id: cat._id,
            name: cat.name,
            isActive: cat.isActive,
            blogCount: countsMap.get(cat._id.toString()) || 0
        }));

        res.json({
            success: true,
            message: 'Categories fetched successfully',
            data
        });
    } catch (error) {
        logError('Error fetching blog categories', error);
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
            .populate({
                path: 'category',
                select: 'name isActive'
            })
            .lean();

        if (!blog) {
            return res.status(404).json({
                success: false,
                message: 'Blog not found'
            });
        }

        if (!blog.category || blog.category.isActive === false) {
            return res.status(404).json({
                success: false,
                message: 'Blog category is inactive'
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
            category: blog.category ? {
                id: blog.category._id,
                name: blog.category.name
            } : null,
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

        const userId = req.user?.userId || null;
        const isAuthenticated = !!userId;

        const favoritePropertyIds = await getFavoritePropertyIds(userId);
        const joinedGroupPropertyIds = await getJoinedGroupPropertyIds(userId);
        const bookedVisitPropertyIds = await getBookedVisitPropertyIds(userId);

        const propertyMap = new Map(properties.map(p => [p._id.toString(), p]));
        const orderedProperties = propertyIds.map(id => propertyMap.get(id.toString())).filter(Boolean);

        const formattedProperties = orderedProperties.map((property, index) => {
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

            const images = formatPropertyImages(property.images);

            const floorPlans = [];
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

            const latitude = property.latitude && !isNaN(property.latitude) && isFinite(property.latitude)
                ? parseFloat(property.latitude) : null;
            const longitude = property.longitude && !isNaN(property.longitude) && isFinite(property.longitude)
                ? parseFloat(property.longitude) : null;

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
                hasMapCoordinates: hasMapCoordinates,
                pinLabel: pinLabel,
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
                images: images,
                mainImage: images.length > 0 ? images[0] : null,
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
            radius = 30
        } = req.query;

        page = parseInt(page);
        limit = parseInt(limit);
        const skip = (page - 1) * limit;

        const filter = { isStatus: true };

        if (search && search.trim()) {
            filter.projectName = { $regex: search.trim(), $options: 'i' };
        }

        const userId = req.user?.userId || null;
        const isAuthenticated = !!userId;

        const favoritePropertyIds = await getFavoritePropertyIds(userId);
        const joinedGroupPropertyIds = await getJoinedGroupPropertyIds(userId);
        const bookedVisitPropertyIds = await getBookedVisitPropertyIds(userId);

        let properties = await Property.find(filter)
            .populate('developer', 'developerName')
            .populate('relationshipManager', 'name email phone')
            .select('projectName location latitude longitude configurations images developerPrice offerPrice discountPercentage minGroupMembers projectId possessionStatus developer reraId description relationshipManager possessionDate createdAt')
            .lean();

        if (latitude && longitude) {
            const userLat = parseFloat(latitude);
            const userLon = parseFloat(longitude);
            const radiusKm = parseFloat(radius) || 30;

            if (isNaN(userLat) || isNaN(userLon) || userLat < -90 || userLat > 90 || userLon < -180 || userLon > 180) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid latitude or longitude values"
                });
            }

            const calculateDistance = (lat1, lon1, lat2, lon2) => {
                const R = 6371;
                const dLat = (lat2 - lat1) * Math.PI / 180;
                const dLon = (lon2 - lon1) * Math.PI / 180;
                const a =
                    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                    Math.sin(dLon / 2) * Math.sin(dLon / 2);
                const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                return R * c;
            };

            properties = properties.filter(property => {
                if (!property.latitude || !property.longitude) {
                    return false;
                }
                const distance = calculateDistance(
                    userLat,
                    userLon,
                    property.latitude,
                    property.longitude
                );
                property.distance = distance;
                return distance <= radiusKm;
            });

            properties.sort((a, b) => (a.distance || Infinity) - (b.distance || Infinity));
        }

        if (!search && !latitude && !longitude) {
            const propertyIds = properties.map(p => p._id);
            const leadCounts = await leadModal.aggregate([
                { $match: { propertyId: { $in: propertyIds }, isStatus: true } },
                { $group: { _id: '$propertyId', count: { $sum: 1 } } }
            ]);

            const leadCountMap = new Map(
                leadCounts.map(item => [item._id.toString(), item.count])
            );

            properties = properties.map(prop => ({
                ...prop,
                leadCount: leadCountMap.get(prop._id.toString()) || 0
            }));

            properties.sort((a, b) => {
                if (b.leadCount !== a.leadCount) {
                    return b.leadCount - a.leadCount;
                }
                return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
            });
        }

        const total = properties.length;

        const paginatedProperties = properties.slice(skip, skip + limit);

        const formattedProperties = paginatedProperties.map(property => {
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
            const isBookVisit = bookedVisitPropertyIds.has(propertyId);

            return {
                id: property._id,
                projectId: property.projectId,
                projectName: property.projectName,
                location: property.location,
                latitude: property.latitude || null,
                longitude: property.longitude || null,
                images: images,
                image: images.length > 0 ? images[0] : null,
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

