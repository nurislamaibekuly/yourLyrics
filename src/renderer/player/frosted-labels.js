// Rasterize the sampled glass into glyph alpha instead of combining CSS masks
// with backdrop-filter, which can expose a rectangular surface in transparent
// windows while labels move or their text masks are replaced.
export function createFrostedLabelsRenderer(backdrop, artwork = () => null) {
  const labels = new Map();

  function remove(label) {
    const state = labels.get(label);
    state?.canvas.remove();
    label.classList.remove('frost-canvas-ready');
    labels.delete(label);
  }

  function setMask(label, mask) {
    let state = labels.get(label);
    if (!state) {
      const canvas = document.createElement('canvas');
      canvas.className = 'frosted-label-pixels';
      canvas.setAttribute('aria-hidden', 'true');
      const labelPatch = document.createElement('canvas');
      state = {
        canvas,
        context: canvas.getContext('2d'),
        patch: labelPatch,
        patchContext: labelPatch.getContext('2d'),
        mask
      };
      labels.set(label, state);
    }
    state.mask = mask;
  }

  function paint() {
    if (!backdrop?.isConnected) return;
    const art = artwork();
    const backgroundLayers = [backdrop, art].filter(Boolean).map(source => ({
      source, rect: source.getBoundingClientRect(), filter: getComputedStyle(source).filter
    }));
    const shade = art ? document.querySelector('.artwork-shade')?.getBoundingClientRect() : null;
    const targets = [];
    for (const [label, state] of labels) {
      if (!label.isConnected || !label.classList.contains('frost-ready')) {
        remove(label);
        continue;
      }
      const rect = label.getBoundingClientRect();
      if (!rect.width || !rect.height || !state.context || !state.patchContext || !state.mask) continue;
      const width = state.mask.naturalWidth || state.mask.width;
      const height = state.mask.naturalHeight || state.mask.height;
      if (!width || !height) continue;
      const offsetWidth = Math.max(1, label.offsetWidth);
      const tint = getComputedStyle(label).getPropertyValue('--frost-tint').trim() || '#ffffff59';
      targets.push({ label, state, rect, width, height, offsetWidth, tint });
    }
    const pendingAttachments = [];
    for (const { label, state, rect, width, height, offsetWidth, tint } of targets) {
      const { patch: labelPatch, patchContext: labelPatchContext } = state;
      const scaleX = width / rect.width;
      const scaleY = height / rect.height;
      const ratio = width / offsetWidth;
      const padding = Math.ceil(36 * ratio);
      const patchWidth = width + padding * 2;
      const patchHeight = height + padding * 2;
      if (labelPatch.width !== patchWidth) labelPatch.width = patchWidth;
      if (labelPatch.height !== patchHeight) labelPatch.height = patchHeight;
      labelPatchContext.clearRect(0, 0, patchWidth, patchHeight);
      for (const layer of backgroundLayers) {
        if (!layer.source.width || !layer.source.height || !layer.rect.width || !layer.rect.height) continue;
        labelPatchContext.filter = layer.filter || 'none';
        // Sample only the patch sub-rectangle from the source canvas when no
        // CSS filter is active on the layer, avoiding a full-window WebGL
        // scaling pass on every 100ms clock tick.
        if (!layer.filter || layer.filter === 'none') {
          const patchLeftCss = rect.left - padding / scaleX;
          const patchTopCss = rect.top - padding / scaleY;
          const patchWihCss = patchWidth / scaleX;
          const patchHgtCss = patchHeight / scaleY;
          const srcScaleX = layer.source.width / layer.rect.width;
          const srcScaleY = layer.source.height / layer.rect.height;
          const sx = (patchLeftCss - layer.rect.left) * srcScaleX;
          const sy = (patchTopCss - layer.rect.top) * srcScaleY;
          const sw = patchWihCss * srcScaleX;
          const sh = patchHgtCss * srcScaleY;
          if (
            sx >= 0 &&
            sy >= 0 &&
            sx + sw <= layer.source.width &&
            sy + sh <= layer.source.height
          ) {
            labelPatchContext.drawImage(
              layer.source,
              sx, sy, sw, sh,
              0, 0, patchWidth, patchHeight
            );
            continue;
          }
        }
        labelPatchContext.drawImage(layer.source,
          padding + (layer.rect.left - rect.left) * scaleX,
          padding + (layer.rect.top - rect.top) * scaleY,
          layer.rect.width * scaleX, layer.rect.height * scaleY);
      }
      labelPatchContext.filter = 'none';
      if (shade) {
        // The artwork scrim is a separate layer above the shared art canvas.
        // Include it before filtering so glyphs match the displayed backdrop.
        const top = padding + (shade.top - rect.top) * scaleY;
        const bottom = top + shade.height * scaleY;
        const gradient = labelPatchContext.createLinearGradient(0, top, 0, bottom);
        gradient.addColorStop(0.23764, '#0000');
        gradient.addColorStop(1, '#00000087');
        labelPatchContext.fillStyle = gradient;
        labelPatchContext.fillRect(0, 0, patchWidth, patchHeight);
      }
      const { canvas, context, mask } = state;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = 'source-over';
      context.filter = `blur(${12 * ratio}px) saturate(170%)`;
      context.drawImage(labelPatch, -padding, -padding);
      context.filter = 'none';
      context.fillStyle = tint;
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = 'destination-in';
      context.imageSmoothingEnabled = false;
      context.drawImage(mask, 0, 0, width, height);
      context.imageSmoothingEnabled = true;
      context.globalCompositeOperation = 'source-over';
      // Updating a clock's textContent removes its previous child canvas.
      // Reattach the existing surface without allocating a new one each tick.
      pendingAttachments.push({ label, canvas });
    }
    for (const { label, canvas } of pendingAttachments) {
      if (canvas.parentElement !== label) label.append(canvas);
      label.classList.add('frost-canvas-ready');
    }
  }

  return { setMask, remove, paint, dispose() {
    for (const label of labels.keys()) remove(label);
  } };
}
