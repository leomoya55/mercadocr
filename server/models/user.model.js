const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    firebaseUid:          { type: String, required: true, unique: true },
    email:                { type: String, required: true },
    nombre:               { type: String, default: '' },
    apellido:             { type: String, default: '' },
    phone:                { type: String, default: '' },
    provincia:            { type: String, default: '' },
    plan:                 { type: String, enum: ['free', 'basic', 'pro'], default: 'free' },
    freeListingUsed:      { type: Boolean, default: false },
    singlePostCredits:    { type: Number, default: 0 },
    listingsCount:        { type: Number, default: 0 },
    planExpiresAt:        { type: Date, default: null },
    stripeCustomerId:     { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null },
    createdAt:            { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);
