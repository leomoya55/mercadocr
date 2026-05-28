const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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
      {
        width:        1200,
        height:       900,
        crop:         'limit',
        quality:      'auto:good',
        fetch_format: 'auto',
      },
    ],
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido. Solo se aceptan imágenes JPEG, PNG, WebP o GIF.'));
    }
  },
});

module.exports = upload;
