import Joi from 'joi';
import mongoose from 'mongoose';
import { Listing } from '../models/Listing.js';
import { User } from '../models/User.js';

const CATEGORIES = ['textbooks', 'electronics', 'furniture', 'clothing', 'other'];
const CONDITIONS = ['new', 'like-new', 'used', 'worn'];

const objectId = Joi.string().hex().length(24);

// status is deliberately not accepted here: new listings always start 'active',
// and status only changes through DELETE (-> removed) or /sold (-> sold).
const createSchema = Joi.object({
  title: Joi.string().trim().min(1).max(120).required(),
  description: Joi.string().trim().max(2000).allow(''),
  price: Joi.number().min(0).required(),
  category: Joi.string().valid(...CATEGORIES),
  condition: Joi.string().valid(...CONDITIONS),
  seller: objectId
});

const updateSchema = Joi.object({
  title: Joi.string().trim().min(1).max(120),
  description: Joi.string().trim().max(2000).allow(''),
  price: Joi.number().min(0),
  category: Joi.string().valid(...CATEGORIES),
  condition: Joi.string().valid(...CONDITIONS),
  seller: objectId
}).min(1);

// Fields that can no longer change once an item has been sold.
const LOCKED_WHEN_SOLD = ['price', 'category', 'seller'];

// Only expose public user fields; populate('seller') alone would include the password hash.
const SELLER_FIELDS = 'name email';

function includeRemoved(req) {
  return req.query.includeRemoved === 'true';
}

async function sellerExists(id) {
  return id === undefined || Boolean(await User.exists({ _id: id }));
}

// GET /api/listings?includeRemoved=true
export async function getAllListings(req, res, next) {
  try {
    const filter = includeRemoved(req) ? {} : { status: { $ne: 'removed' } };
    const listings = await Listing.find(filter)
      .populate('seller', SELLER_FIELDS)
      .sort({ createdAt: -1 })
      .lean();
    res.json({ listings });
  } catch (err) { next(err); }
}

// GET /api/listings/:id?includeRemoved=true
export async function getListing(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid listing id' });
    }

    const listing = await Listing.findById(req.params.id).populate('seller', SELLER_FIELDS).lean();
    if (!listing || (listing.status === 'removed' && !includeRemoved(req))) {
      return res.status(404).json({ message: 'Listing not found' });
    }
    res.json({ listing });
  } catch (err) { next(err); }
}

// POST /api/listings
export async function createListing(req, res, next) {
  try {
    const { value, error } = createSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).json({ message: error.message });

    if (!(await sellerExists(value.seller))) {
      return res.status(400).json({ message: 'Seller not found' });
    }

    const listing = await Listing.create(value);
    res.status(201).json({ listing });
  } catch (err) { next(err); }
}

// PATCH /api/listings/:id
export async function updateListing(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid listing id' });
    }

    const { value, error } = updateSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).json({ message: error.message });

    const existing = await Listing.findById(req.params.id);
    if (!existing || existing.status === 'removed') {
      return res.status(404).json({ message: 'Listing not found' });
    }

    if (existing.status === 'sold') {
      const locked = LOCKED_WHEN_SOLD.filter((field) => field in value);
      if (locked.length) {
        return res.status(409).json({ message: `Cannot change ${locked.join(', ')} on a sold listing` });
      }
    }

    if (!(await sellerExists(value.seller))) {
      return res.status(400).json({ message: 'Seller not found' });
    }

    // The status condition guards against the listing being removed between the read and this write.
    const listing = await Listing.findOneAndUpdate(
      { _id: req.params.id, status: { $ne: 'removed' } },
      { $set: value },
      { new: true, runValidators: true }
    );
    if (!listing) return res.status(404).json({ message: 'Listing not found' });
    res.json({ listing });
  } catch (err) { next(err); }
}

// PATCH /api/listings/:id/sold
export async function markListingSold(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid listing id' });
    }

    // Only an active listing can become sold; the filter makes this a single atomic check-and-set.
    const listing = await Listing.findOneAndUpdate(
      { _id: req.params.id, status: 'active' },
      { $set: { status: 'sold' } },
      { new: true }
    );
    if (listing) return res.json({ listing });

    const existing = await Listing.findById(req.params.id).lean();
    if (!existing || existing.status === 'removed') {
      return res.status(404).json({ message: 'Listing not found' });
    }
    res.status(409).json({ message: 'Listing is already sold' });
  } catch (err) { next(err); }
}

// DELETE /api/listings/:id — soft delete: flag as removed, keep the document.
export async function deleteListing(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid listing id' });
    }

    const listing = await Listing.findOneAndUpdate(
      { _id: req.params.id, status: { $ne: 'removed' } },
      { $set: { status: 'removed' } },
      { new: true }
    );
    if (!listing) return res.status(404).json({ message: 'Listing not found' });
    res.json({ listing });
  } catch (err) { next(err); }
}
