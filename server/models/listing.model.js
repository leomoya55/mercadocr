const mongoose = require('mongoose');

const Schema = mongoose.Schema;

const listingSchema = new Schema({
    name: { type: String, required: true },
    description: { type: String, required: true },
    price: { type: Number, required: true },
    category: { type: String, required: true },
    photos: [{ type: String, required: true }],
    contact: { type: String, required: true },
    provincia: { type: String, required: true },
    author: { type: String, required: true }, // Firebase UID
    featured: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'sold'], default: 'active' },
}, {
    timestamps: true,
});

const Listing = mongoose.model('Listing', listingSchema);

module.exports = Listing;
