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

    return ok({
      prompt,
      model: modelKey,
      model_id: modelId,
      mime,
      size_bytes: base64.length,
      image_base64: base64,
      hint: 'render_as: &lt;BDS:IMAGE src="data:{mime};base64,{image_base64}" />'
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

function uint8ToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
