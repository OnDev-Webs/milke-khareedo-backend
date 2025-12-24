const mongoose = require('mongoose');

const leadActivitySchema = new mongoose.Schema({
    leadId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Lead',
        required: true
    },
    activityType: {
        type: String,
        enum: ['phone_call', 'whatsapp', 'email', 'visit', 'follow_up', 'join_group', 'status_update', 'remark_update'],
        required: true
    },
    activityDate: {
        type: Date,
        default: Date.now
    },
    performedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    performedByName: {
        type: String,
        required: true
    },
    description: {
        type: String,
        default: ''
    },
    // For follow-up activities
    nextFollowUpDate: {
        type: Date
    },
    // For status updates
    oldStatus: {
        type: String
    },
    newStatus: {
        type: String
    },
    // For visit activities
    visitDate: {
        type: Date
    },
    visitTime: {
        type: String
    },
    // Additional metadata
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, {
    timestamps: true
});

// Index for faster queries
leadActivitySchema.index({ leadId: 1, activityDate: -1 });
leadActivitySchema.index({ leadId: 1, activityType: 1 });

module.exports = mongoose.model('LeadActivity', leadActivitySchema);




