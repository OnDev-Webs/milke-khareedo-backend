const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    propertyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Property"
    },
    relationshipManagerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    rmEmail: { type: String },
    rmPhone: { type: String },
    message: { type: String },
    date: {
        type: Date,
        default: Date.now
    },
    scheduleDate: {
        type: Date
    },
    isStatus: {
        type: Boolean,
        default: true
    },
    source: {
        type: String,
        default: "origin"
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    visitStatus: {
        type: String,
        enum: ['not_visited', 'visited', 'follow_up'],
        default: 'not_visited'
    },
    status: {
        type: String,
        enum: [
            'lead_received',
            'interested',
            'no_response_dnp',
            'unable_to_contact',
            'call_back_scheduled',
            'demo_discussion_ongoing',
            'site_visit_coordination',
            'site_visit_confirmed',
            'commercial_negotiation',
            'deal_closed',
            'declined_interest',
            'does_not_meet_requirements',
            'pending',
            'approved',
            'rejected'
        ],
        default: 'lead_received'
    },
    ipAddress: {
        type: String
    }
}, {
    timestamps: true
});

module.exports = mongoose.model("Lead", leadSchema);
