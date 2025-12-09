const Developer = require("../models/developer");
const Property = require("../models/property");


exports.getAllProperties = async (req, res, next) => {
    try {
        let { page = 1, limit = 12, search, city, developer, status } = req.query;
        page = parseInt(page);
        limit = parseInt(limit);

        const filters = {};

        if (city) filters.location = city;
        if (developer) filters.developer = developer;
        if (status) filters.status = status;

        if (search) {
            filters.$or = [
                { projectName: { $regex: search, $options: 'i' } },
                { 'developer.name': { $regex: search, $options: 'i' } }
            ];
        }

        const total = await Property.countDocuments(filters);

        const properties = await Property.find(filters)
            .populate('developer', 'name')
            .populate('relationshipManager', 'name')
            .populate('leadDistributionAgents', 'name')
            .skip((page - 1) * limit)
            .limit(limit)
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            data: properties,
            total,
            page,
            totalPages: Math.ceil(total / limit),
            count: properties.length,
        });

    } catch (error) {
        next(error);
    }
};

exports.getAllDevelopers = async (req, res, next) => {
    try {
        const filters = {};
        if (req.query.city) filters.city = req.query.city;

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const total = await Developer.countDocuments(filters);
        const developers = await Developer.find(filters)
            .skip(skip)
            .limit(limit);

        res.json({
            success: true,
            data: developers,
            count: developers.length,
            total,
            page,
            limit,
        });
    } catch (error) {
        next(error);
    }
};

exports.getAdminDashboard = async (req, res, next) => {
    try {
        // Total Developers
        const totalDevelopers = await Developer.countDocuments();

        // Total Projects
        const totalProjects = await Property.countDocuments();

        // Live Projects (Active or Under Construction)
        const liveProjects = await Property.countDocuments({
            status: 'Active'
        });


        res.json({
            success: true,
            data: {
                totalDevelopers,
                totalProjects,
                liveProjects,
            }
        });
    } catch (error) {
        next(error);
    }
};