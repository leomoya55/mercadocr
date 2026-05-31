const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// Do NOT configure here.
// cloudinary.config({ ... });

let configured = false;

function configureCloudinary() {
  if (configured) return;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  configured = true;
  console.log('[Cloudinary] Configuration complete.');
}


// Helper to extract public_id from a Cloudinary URL
function getPublicIdFromUrl(url) {
  try {
    const regex = /mercadocr\/listings\/([a-zA-Z0-9_-]+)/;
    const match = url.match(regex);
    return match ? `mercadocr/listings/${match[1]}` : null;
  } catch (e) {
    console.error('Could not parse public_id from URL:', url, e);
    return null;
  }
}

// Validate actual MIME type, not just the file extension, to block disguised files.
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:           'mercadocr/listings',
    allowed_formats:  ['jpg', 'png', 'jpeg', 'webp', 'gif'],
    // Resize to ≤1200×900 (never upscale), convert to WebP, quality auto:good.
    // fetch_format:auto lets Cloudinary serve AVIF/WebP to browsers that support them.
    transformation: [
      { width: 1200, height: 900, crop: 'limit' },
      { quality: 'auto:good', fetch_format: 'auto' },
    ],
  },
});

module.exports = {
  cloudinary,
  storage,
  upload: multer({
    storage,
    fileFilter: (req, file, cb) => {
      if (ALLOWED_MIMES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Tipo de archivo no permitido. Solo se aceptan imágenes (jpg, png, webp, gif).'), false);
      }
    },
    limits: { fileSize: 1024 * 1024 * 10 }, // 10 MB
  }),
  getPublicIdFromUrl,
  configureCloudinary,
};
