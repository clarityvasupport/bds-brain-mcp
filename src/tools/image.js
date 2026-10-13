/**
 * Image tools.
 *
 *   generate_image   — text-to-image via Workers AI
 *   transform_image  — placeholder; needs Cloudflare Images (paid)
 */

import { ok, err, classifyError } from '../envelope.js';

const IMAGE_MODELS = {
  flux: '@cf/black-forest-labs/flux-1-schnell',
  sdxl: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
  dreamshaper: '@cf/lykon/dreamshaper-8-lcm'
};

/* ------------------------------------------------------------------------ */
/* generate_image                                                            */
/* ------------------------------------------------------------------------ */

export async function generateImage(env, { prompt, model = 'flux', steps = 4 }) {
  if (!prompt || typeof prompt !== 'string') {
    return err('VALIDATION', 'prompt is required and must be a string');
  }
  const modelKey = String(model).toLowerCase();
  const modelId = IMAGE_MODELS[modelKey] || IMAGE_MODELS.flux;

  try {
    const inputs = { prompt };
    if (modelKey === 'flux') inputs.steps = Math.max(1, Math.min(8, Number(steps) || 4));

    const output = await env.AI.run(modelId, inputs);

    // Different models return different shapes. Normalise to base64.
    let base64 = null;
    let mime = 'image/png';

    if (output instanceof Uint8Array) {
      base64 = uint8ToBase64(output);
    } else if (output && output.image) {
      base64 = output.image;
    } else if (typeof output === 'string') {
      base64 = output;
    }

    if (!base64) {
      return err('INTERNAL', 'Image model returned unrecognised output shape', {
        model: modelId,
        outputType: typeof output
      });
    }

    // The model's output format may differ from its label. Sniff the real
    // bytes so the stored mime and served Content-Type are accurate.
    mime = sniffMime(base64);

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    await env.BDS_META.prepare(
      `INSERT INTO images (id, base64, mime, prompt, model, size_bytes, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(id, base64, mime, prompt, modelKey, base64.length, new Date().toISOString()).run();

    return ok({
      prompt,
      model: modelKey,
      model_id: modelId,
      mime,
      size_bytes: base64.length,
      id,
      url: `https://bds-brain-mcp.clarityva-support.workers.dev/image/${id}`
    });
  } catch (e) {
    return err(classifyError(e), String(e.message || e), { prompt, model: modelKey });
  }
}

/* ------------------------------------------------------------------------ */
/* transform_image — placeholder                                             */
/* ------------------------------------------------------------------------ */

export async function transformImage(env, { url, ops }) {
  return err(
    'INTERNAL',
    'transform_image is not implemented. Image resize/crop on Cloudflare ' +
      'requires Cloudflare Images (a paid product) or a WASM image library ' +
      'bundled into the Worker. See README for options.',
    { url, ops }
  );
}

/* ------------------------------------------------------------------------ */
/* helpers                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Sniff the real image mime from a base64 string's magic bytes.
 * The AI models return different formats than their names suggest —
 * flux-schnell, for example, returns JPEG while we assumed PNG.
 */
function sniffMime(base64) {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return 'application/octet-stream';
}

function uint8ToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
