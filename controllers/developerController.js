const Developer = require('../models/developer');
const { uploadToS3 } = require('../utils/s3');

// Create a new developer
exports.createDeveloper = async (req, res, next) => {
    try {
        // S3 upload
        const logo = req.file ? await uploadToS3(req.file) : null;

        const {
            developerName,
            description,
            city,
            establishedYear,
            website,
            totalProjects,
            sourcingManager
        } = req.body;

        // Sourcing manager should be object, not string
        let parsedSourcingManager = sourcingManager;
        if (typeof sourcingManager === 'string') {
            try {
                parsedSourcingManager = JSON.parse(sourcingManager);
            } catch (err) {
                return res.status(400).json({ success: false, message: "Invalid sourcingManager JSON" });
            }
        }

        if (!logo || !developerName || !city || !parsedSourcingManager?.name || !parsedSourcingManager?.mobile) {
            return res.status(400).json({
                success: false,
                message: "All required fields are mandatory"
            });
        }

        const developer = await Developer.create({
            logo,
            developerName,
            description,
            city,
            establishedYear,
            website,
            totalProjects,
            sourcingManager: parsedSourcingManager
        });

        res.status(201).json({
            success: true,
            message: "Developer created successfully",
            data: developer
        });
    } catch (error) {
        next(error);
    }
};

// Get all developers
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

// Get developer by ID
exports.getDeveloperById = async (req, res, next) => {
    try {
        const developer = await Developer.findById(req.params.id);
        if (!developer) return res.status(404).json({ success: false, message: 'Developer not found' });
        res.json({ success: true, data: developer });
    } catch (error) {
        next(error);
    }
};

// Update developer
exports.updateDeveloper = async (req, res, next) => {
    try {
        const allowedFields = [
            'developerName',
            'description',
            'city',
            'establishedYear',
            'website',
            'totalProjects',
            'sourcingManager'
        ];

        const updates = {};

        // Upload new logo if file exists
        if (req.file) {
            updates.logo = await uploadToS3(req.file);
        }

        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) {
                if (field === 'sourcingManager' && typeof req.body[field] === 'string') {
                    try {
                        updates[field] = JSON.parse(req.body[field]);
                    } catch (err) {
                        return res.status(400).json({ success: false, message: "Invalid sourcingManager JSON" });
                    }
                } else {
                    updates[field] = req.body[field];
                }
            }
        });

        const developer = await Developer.findByIdAndUpdate(req.params.id, updates, {
            new: true,
            runValidators: true
        });

        if (!developer) return res.status(404).json({ success: false, message: 'Developer not found' });

        res.json({ success: true, message: 'Developer updated successfully', data: developer });
    } catch (error) {
        next(error);
    }
};

// Delete developer
exports.deleteDeveloper = async (req, res, next) => {
    try {
        const developer = await Developer.findByIdAndDelete(req.params.id);
        if (!developer) return res.status(404).json({ success: false, message: 'Developer not found' });
        res.json({ success: true, message: 'Developer deleted successfully' });
    } catch (error) {
        next(error);
    }
};
