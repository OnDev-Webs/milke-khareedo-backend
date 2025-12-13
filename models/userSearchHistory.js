const mongoose = require('mongoose');

const userSearchHistorySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    searchQuery: { type: String, required: true },
    location: { type: String },
    developer: { type: new mongoose.Schema.Types.ObjectId, ref: 'Developer' }, 
    projectName: { type: String }, 
}, { timestamps: true });


module.exports = mongoose.model('UserSearchHistory', userSearchHistorySchema);
