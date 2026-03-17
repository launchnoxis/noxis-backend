/**
 * metadata.js
 * Uploads token metadata JSON (and optionally image) to IPFS via Pinata.
 * Falls back to a mock URI on devnet if Pinata keys are not configured.
 */

const axios = require('axios');
const FormData = require('form-data');

const PINATA_BASE = 'https://api.pinata.cloud';

function getPinataHeaders() {
  return {
    pinata_api_key: process.env.PINATA_API_KEY,
    pinata_secret_api_key: process.env.PINATA_SECRET_KEY,
  };
}

function hasPinataConfig() {
  return (
    process.env.PINATA_API_KEY &&
    process.env.PINATA_API_KEY !== 'your_pinata_api_key' &&
    process.env.PINATA_SECRET_KEY
  );
}

/**
 * Upload a JSON object to IPFS
 * Returns the IPFS gateway URL
 */
async function uploadJson(json, name = 'metadata.json') {
  if (!hasPinataConfig()) {
    // Devnet/test fallback — use a mock URI
    console.warn('[metadata] Pinata not configured — using mock URI');
    return `https://ipfs.io/ipfs/QmMockDevnet${Date.now()}`;
  }

  const res = await axios.post(
    `${PINATA_BASE}/pinning/pinJSONToIPFS`,
    {
      pinataContent: json,
      pinataMetadata: { name },
    },
    { headers: getPinataHeaders() }
  );

  return `https://gateway.pinata.cloud/ipfs/${res.data.IpfsHash}`;
}

/**
 * Upload an image from a URL to IPFS (re-pin)
 * Returns the IPFS gateway URL, or original URL if upload fails
 */
async function uploadImageFromUrl(imageUrl) {
  if (!hasPinataConfig()) return imageUrl;

  try {
    const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const contentType = imageRes.headers['content-type'] || 'image/png';
    const ext = contentType.split('/')[1] || 'png';

    const form = new FormData();
    form.append('file', Buffer.from(imageRes.data), {
      filename: `token-image.${ext}`,
      contentType,
    });
    form.append(
      'pinataMetadata',
      JSON.stringify({ name: `token-image-${Date.now()}.${ext}` })
    );

    const res = await axios.post(`${PINATA_BASE}/pinning/pinFileToIPFS`, form, {
      headers: {
        ...getPinataHeaders(),
        ...form.getHeaders(),
      },
    });

    return `https://gateway.pinata.cloud/ipfs/${res.data.IpfsHash}`;
  } catch (err) {
    console.warn('[metadata] Image upload failed, using original URL:', err.message);
    return imageUrl;
  }
}

/**
 * Build and upload the full pump.fun-compatible metadata JSON
 *
 * pump.fun metadata format:
 * {
 *   name, symbol, description, image,
 *   showName: true,
 *   createdOn: "https://pump.fun",
 *   twitter, telegram, website
 * }
 */
async function uploadMetadata({ name, symbol, description, imageUrl, twitter, telegram, website }) {
  // Re-pin image to IPFS for permanence
  const finalImageUrl = imageUrl ? await uploadImageFromUrl(imageUrl) : '';

  const metadata = {
    name,
    symbol,
    description,
    image: finalImageUrl,
    showName: true,
    createdOn: 'https://pump.fun',
    ...(twitter && { twitter }),
    ...(telegram && { telegram }),
    ...(website && { website }),
  };

  const uri = await uploadJson(metadata, `${symbol.toLowerCase()}-metadata.json`);
  return uri;
}

module.exports = { uploadMetadata, uploadJson, uploadImageFromUrl };
