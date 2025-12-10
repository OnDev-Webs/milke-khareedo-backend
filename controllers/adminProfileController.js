const Developer = require("../models/developer");
const leadModal = require("../models/leadModal");
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

exports.getLeadsList = async (req, res) => {
    try {
        const userId = req.user.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        // Total leads count
        const total = await leadModal.countDocuments({ userId });

        // Fetch paginated leads
        const leads = await leadModal.find({ userId })
            .populate({
                path: "propertyId",
                select: "name location relationshipManager",
                populate: {
                    path: "relationshipManager",
                    select: "name"
                }
            })
            .populate("userId", "name email phone")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const formattedData = leads.map(item => ({
            leadId: item._id,
            userName: item.userId?.name,
            email: item.userId?.email,
            phone: item.userId?.phone,
            propertyName: item.propertyId?.name,
            location: item.propertyId?.location,
            relationshipManager: item.propertyId?.relationshipManager?.name || "",
            rmEmail: item.rmEmail,
            rmPhone: item.rmPhone,
            date: item.createdAt.toLocaleDateString(),
            time: item.createdAt.toLocaleTimeString(),
            status: item.status || "Pending"
        }));

        res.json({
            success: true,
            message: "Lead list fetched successfully",
            data: formattedData,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};

exports.viewLeadDetails = async (req, res) => {
    try {
        const { leadId } = req.params;

        const lead = await leadModal.findById(leadId)
            .populate({
                path: "propertyId",
                populate: [
                    { path: "relationshipManager", select: "name email phone" },
                ]
            })
            .populate("userId", "name email phone")
            .lean();

        if (!lead) {
            return res.status(404).json({ success: false, message: "Lead not found" });
        }

        const data = {
            leadId: lead._id,
            user: {
                name: lead.userId?.name,
                email: lead.userId?.email,
                phone: lead.userId?.phone
            },
            property: {
                name: lead.propertyId?.name,
                location: lead.propertyId?.location,
                possessionDate: lead.propertyId?.possessionDate,
                configurations: lead.propertyId?.configurations,
                amenities: lead.propertyId?.amenities,
                images: lead.propertyId?.images,
                relationshipManager: lead.propertyId?.relationshipManager
            },
            rmEmail: lead.rmEmail,
            rmPhone: lead.rmPhone,
            status: lead.status,
            createdAt: lead.createdAt,
            updatedAt: lead.updatedAt
        };
        res.json({ success: true, message: "Lead details fetched successfully", data });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.deleteLead = async (req, res) => {
    try {
        const userId = req.user.userId;
        const leadId = req.params.leadId;

        const deletedLead = await leadModal.findOneAndDelete({ _id: leadId, userId });

        if (!deletedLead) {
            return res.status(404).json({
                success: false,
                message: "Lead not found or already deleted"
            });
        }

        res.json({
            success: true,
            message: "Lead deleted successfully"
        });

    } catch (error) {
        res.json({
            success: false,
            message: error.message
        });
    }
};
