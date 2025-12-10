const mongoose = require('mongoose');

const userPropertyActivitySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    
    activityType: {
        type: String,
        enum: ["viewed", "favorite", "visited"],
        required: true
    },

    lastViewedAt: { type: Date }, 
    favoritedAt: { type: Date },
    visitedAt: { type: Date },
    
    visitDate: { type: Date },  
    visitTime: { type: String }, 
    
}, { timestamps: true });

module.exports = mongoose.model('UserPropertyActivity', userPropertyActivitySchema);
