const NODE_NAME_LIMIT = 25;
const COMPONENT_NAME_LIMIT = 25;
const OPACITY_DECIMALS = 3;

const ASSIGNMENTS_STORAGE_KEY = "color-inventory-assignments-v1";
const DATABASE_STORAGE_KEY = "color-inventory-database-v1";
const PALETTE_ORDER = [
  "Gray",
  "Cyan",
  "Violet",
  "Success",
  "Warning",
  "Danger",
  "Incident",
  "Unassigned"
];

figma.showUI(__html__, { width: 1080, height: 816, themeColors: true });

let lastAnalysis = null;

sendSelection();
sendDatabase(false);
figma.on("selectionchange", sendSelection);

figma.ui.onmessage = async (msg) => {
  if (msg.type === "analyze") {
    await analyzeSelection(msg.appearance);
  }

  if (msg.type === "assign" && msg.key) {
    const assignments =
      (await figma.clientStorage.getAsync(ASSIGNMENTS_STORAGE_KEY)) || {};
    const palette = String(msg.palette || "").trim();

    if (!palette || palette === "Unassigned") {
      delete assignments[msg.key];
    } else {
      assignments[msg.key] = palette;
    }

    await figma.clientStorage.setAsync(
      ASSIGNMENTS_STORAGE_KEY,
      assignments
    );

    const database = await getDatabase();
    database.assignments = assignments;
    pruneDatabaseSources(database, assignments);
    await figma.clientStorage.setAsync(DATABASE_STORAGE_KEY, database);
  }

  if (
    msg.type === "assign-many" &&
    Array.isArray(msg.keys) &&
    msg.keys.length
  ) {
    const assignments =
      (await figma.clientStorage.getAsync(ASSIGNMENTS_STORAGE_KEY)) || {};
    const palette = String(msg.palette || "").trim();
    msg.keys.forEach((key) => {
      if (!palette || palette === "Unassigned") {
        delete assignments[key];
      } else {
        assignments[key] = palette;
      }
    });
    await figma.clientStorage.setAsync(
      ASSIGNMENTS_STORAGE_KEY,
      assignments
    );
    const database = await getDatabase();
    database.assignments = assignments;
    pruneDatabaseSources(database, assignments);
    await figma.clientStorage.setAsync(DATABASE_STORAGE_KEY, database);
  }

  if (msg.type === "rename-suggestion" && msg.key) {
    const database = await getDatabase();
    if (!database.suggestedNames) database.suggestedNames = {};
    const value = String(msg.value || "").trim();
    if (value) {
      database.suggestedNames[msg.key] = value;
    } else {
      delete database.suggestedNames[msg.key];
    }
    await figma.clientStorage.setAsync(DATABASE_STORAGE_KEY, database);
  }

  if (msg.type === "add-to-database") {
    await addCurrentToDatabase(msg.assignments);
  }

  if (msg.type === "get-database") {
    await sendDatabase(true);
  }

  if (msg.type === "import-database") {
    await importDatabase(msg.database);
  }

  if (msg.type === "clear-database") {
    await clearDatabase();
  }
};

function emptyDatabase() {
  return {
    version: 2,
    assignments: {},
    suggestedNames: {},
    sources: {}
  };
}

function flattenSuggestedName(path) {
  return String(path || "").replace(
    /^([^/]+)\/([^/]+)\/([^/]+)\/(\d{2})$/,
    "$1/$2/$3-$4"
  );
}

function flattenSuggestedNames(map) {
  const result = {};
  Object.keys(map || {}).forEach((key) => {
    const value = flattenSuggestedName(map[key]);
    if (value) result[key] = value;
  });
  return result;
}

async function getDatabase() {
  const stored = await figma.clientStorage.getAsync(DATABASE_STORAGE_KEY);
  const legacyAssignments =
    (await figma.clientStorage.getAsync(ASSIGNMENTS_STORAGE_KEY)) || {};
  if (!stored) {
    const database = emptyDatabase();
    database.assignments = legacyAssignments;
    return database;
  }

  if (stored.version === 1 && stored.scans) {
    const migrated = emptyDatabase();
    migrated.assignments = Object.assign(
      {},
      legacyAssignments,
      stored.assignments || {}
    );
    migrated.suggestedNames = flattenSuggestedNames(stored.suggestedNames);
    Object.keys(stored.scans).forEach((name) => {
      const scan = stored.scans[name];
      const id = `legacy:${name}`;
      migrated.sources[id] = {
        id,
        name,
        fileName: scan.fileName || "",
        pageName: scan.pageName || "",
        updatedAt: scan.savedAt || new Date().toISOString(),
        rows: scan.rows || []
      };
    });
    return migrated;
  }

  if (stored.version !== 2 || !stored.sources) {
    const database = emptyDatabase();
    database.assignments = legacyAssignments;
    return database;
  }

  stored.assignments = Object.assign(
    {},
    legacyAssignments,
    stored.assignments || {}
  );
  stored.suggestedNames = flattenSuggestedNames(stored.suggestedNames);
  stored.sources = stored.sources || {};
  return stored;
}

async function addCurrentToDatabase(assignmentsOverride) {
  if (!lastAnalysis) {
    figma.notify("Analyze a selection before saving");
    return;
  }

  const database = await getDatabase();
  const assignments =
    assignmentsOverride && typeof assignmentsOverride === "object"
      ? assignmentsOverride
      : database.assignments || {};
  database.assignments = assignments;
  await figma.clientStorage.setAsync(
    ASSIGNMENTS_STORAGE_KEY,
    assignments
  );
  pruneDatabaseSources(database, assignments);

  let savedColorCount = 0;
  lastAnalysis.sources.forEach((source) => {
    const rows = source.rows
      .filter((row) => isSavedPalette(assignments[row.key]))
      .map((row) => ({
        ...row,
        palette: assignments[row.key]
      }));
    savedColorCount += rows.length;
    database.sources[source.id] = {
      id: source.id,
      name: source.name,
      fileName: source.fileName,
      pageName: source.pageName,
      updatedAt: new Date().toISOString(),
      rows
    };
  });

  if (!savedColorCount) {
    figma.notify("Assign at least one color before saving");
    return;
  }

  await figma.clientStorage.setAsync(DATABASE_STORAGE_KEY, database);
  figma.notify(
    `Database updated: ${lastAnalysis.sources.length} frame(s)`
  );
  await sendDatabase(true);
}

function isSavedPalette(palette) {
  return Boolean(
    palette &&
    palette !== "Unassigned"
  );
}

function paletteRank(palette) {
  const index = PALETTE_ORDER.indexOf(palette);
  return index === -1 ? PALETTE_ORDER.length - 1.5 : index;
}

function pruneDatabaseSources(database, assignments) {
  Object.keys(database.sources || {}).forEach((sourceId) => {
    const source = database.sources[sourceId];
    source.rows = (source.rows || []).filter((row) =>
      isSavedPalette(assignments[row.key])
    );
  });
}

function mergeUnique(target, values) {
  (values || []).forEach((value) => addUnique(target, value));
}

function inferRowRole(row) {
  const types = row.nodeTypes || [];
  const properties = row.properties || [];
  if (types.indexOf("TEXT") !== -1) return "text";
  if (properties.length === 1 && properties[0] === "stroke") {
    return "border";
  }
  if (
    types.indexOf("VECTOR") !== -1 ||
    types.indexOf("BOOLEAN_OPERATION") !== -1
  ) {
    return "icon";
  }
  if (properties.indexOf("fill") !== -1) return "surface";
  return "color";
}

function rowAppearances(row) {
  const appearances = (row.appearances || []).filter(
    (value) => value === "light" || value === "dark"
  );
  return appearances;
}

async function aggregateDatabase(database) {
  const assignments = database.assignments || {};
  const map = new Map();

  Object.keys(database.sources).forEach((sourceId) => {
    const databaseSource = database.sources[sourceId];
    (databaseSource.rows || []).forEach((sourceRow) => {
      const palette = assignments[sourceRow.key];
      if (!isSavedPalette(palette)) return;
      const role = sourceRow.role || inferRowRole(sourceRow);

      rowAppearances(sourceRow).forEach((appearance) => {
        const candidateKey = [
          appearance,
          palette,
          role,
          sourceRow.key
        ].join("|");
        let row = map.get(candidateKey);
        if (!row) {
          row = {
            key: candidateKey,
            colorKey: sourceRow.key,
            palette,
            role,
            hex: sourceRow.hex,
            opacity: sourceRow.opacity,
            uses: 0,
            lightness: sourceRow.lightness,
            chroma: sourceRow.chroma,
            hue: sourceRow.hue,
            properties: [],
            bindings: [],
            variables: [],
            styles: [],
            components: [],
            nodes: [],
            nodeTypes: [],
            tokenRefs: [],
            appearances: [appearance],
            sources: []
          };
          map.set(candidateKey, row);
        }

        row.uses += Number(sourceRow.uses) || 0;
        mergeUnique(row.properties, sourceRow.properties);
        mergeUnique(row.bindings, sourceRow.bindings);
        mergeUnique(row.variables, sourceRow.variables);
        mergeUnique(row.styles, sourceRow.styles);
        mergeUnique(row.components, sourceRow.components);
        mergeUnique(row.nodes, sourceRow.nodes);
        mergeUnique(row.nodeTypes, sourceRow.nodeTypes);
        (sourceRow.tokenRefs || []).forEach((ref) => {
          addTokenRef(row.tokenRefs, ref);
        });
        addUnique(row.sources, databaseSource.name || sourceId);
      });
    });
  });

  const rows = Array.from(map.values());
  rows.sort((a, b) => {
    const pa = paletteRank(a.palette);
    const pb = paletteRank(b.palette);
    if (pa !== pb) return pa - pb;
    return b.lightness - a.lightness;
  });
  return rows;
}

async function sendDatabase(open) {
  const database = await getDatabase();
  const rows = await aggregateDatabase(database);
  figma.ui.postMessage({
    type: "database",
    open: Boolean(open),
    database,
    sourceCount: Object.keys(database.sources).length,
    colorCount: rows.length,
    rows
  });
}

async function importDatabase(database) {
  const isV1 =
    database &&
    database.version === 1 &&
    database.scans &&
    !Array.isArray(database.scans);
  const isV2 =
    database &&
    database.version === 2 &&
    database.sources &&
    !Array.isArray(database.sources);
  if (!isV1 && !isV2) {
    figma.notify("Invalid Color Inventory database");
    return;
  }

  await figma.clientStorage.setAsync(DATABASE_STORAGE_KEY, database);
  await figma.clientStorage.setAsync(
    ASSIGNMENTS_STORAGE_KEY,
    database.assignments || {}
  );
  figma.notify("Database imported");
  await sendDatabase(true);
}

async function clearDatabase() {
  const database = emptyDatabase();
  await figma.clientStorage.setAsync(DATABASE_STORAGE_KEY, database);
  await figma.clientStorage.setAsync(ASSIGNMENTS_STORAGE_KEY, {});

  if (lastAnalysis) {
    lastAnalysis.rows.forEach((row) => {
      row.palette = "Unassigned";
    });
    lastAnalysis.sources.forEach((source) => {
      source.rows.forEach((row) => {
        row.palette = "Unassigned";
      });
    });
  }

  figma.ui.postMessage({ type: "database-cleared" });
  figma.notify("Color Inventory database cleared");
  await sendDatabase(false);
}

function sendSelection() {
  figma.ui.postMessage({
    type: "selection",
    count: figma.currentPage.selection.length
  });
}

function roundOpacity(value) {
  const n = value == null ? 1 : value;
  const factor = Math.pow(10, OPACITY_DECIMALS);
  return Math.round(n * factor) / factor;
}

function rgbToHex(r, g, b) {
  const toHex = (value) =>
    Math.round(value * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbToOklab(r, g, b) {
  r = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
  g = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
  b = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  };
}

function chromaOf(color) {
  return Math.sqrt(color.a * color.a + color.b * color.b);
}

function hueOf(color) {
  let hue = (Math.atan2(color.b, color.a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return hue;
}

function colorKey(hex, opacity) {
  return `${hex}|${opacity}`;
}

function addUnique(list, value) {
  if (value && list.indexOf(value) === -1) {
    list.push(value);
  }
}

function addTokenRef(list, ref) {
  if (!ref || !ref.key) return;
  const exists = list.some((item) => item.key === ref.key);
  if (!exists) list.push(ref);
}

async function resolveVariableName(id, cache) {
  if (!id) return "";
  if (cache.has(id)) return cache.get(id);
  let name = id;
  try {
    const variable = await figma.variables.getVariableByIdAsync(id);
    if (variable && variable.name) name = variable.name;
  } catch (e) {
    name = id;
  }
  cache.set(id, name);
  return name;
}

async function resolveStyleName(id, cache) {
  if (!id || id === figma.mixed) return "";
  if (cache.has(id)) return cache.get(id);
  let name = "";
  try {
    const style = await figma.getStyleByIdAsync(id);
    if (style && style.name) name = style.name;
  } catch (e) {
    name = "";
  }
  cache.set(id, name);
  return name;
}

async function resolveInstanceComponent(node, cache) {
  if (cache.has(node.id)) return cache.get(node.id);
  let name = node.name || "Instance";
  try {
    const main = await node.getMainComponentAsync();
    if (main) {
      name =
        main.parent && main.parent.type === "COMPONENT_SET"
          ? main.parent.name
          : main.name;
    }
  } catch (e) {
    name = node.name || "Instance";
  }
  cache.set(node.id, name);
  return name;
}

function getSolidPaints(node) {
  const paints = [];

  if ("fills" in node && Array.isArray(node.fills)) {
    const styleId = "fillStyleId" in node ? node.fillStyleId : "";
    node.fills.forEach((paint) => {
      if (
        paint &&
        paint.type === "SOLID" &&
        paint.visible !== false &&
        paint.color
      ) {
        paints.push({
          color: paint.color,
          opacity: roundOpacity(paint.opacity),
          property: "fill",
          paint,
          styleId
        });
      }
    });
  }

  if ("strokes" in node && Array.isArray(node.strokes)) {
    const styleId = "strokeStyleId" in node ? node.strokeStyleId : "";
    node.strokes.forEach((paint) => {
      if (
        paint &&
        paint.type === "SOLID" &&
        paint.visible !== false &&
        paint.color
      ) {
        paints.push({
          color: paint.color,
          opacity: roundOpacity(paint.opacity),
          property: "stroke",
          paint,
          styleId
        });
      }
    });
  }

  return paints;
}

function getVariableId(paint) {
  const bound = paint.boundVariables;
  if (!bound) return "";
  if (bound.color && bound.color.id) return bound.color.id;
  return "";
}

function bindingType(variableId, styleName) {
  if (variableId) return "variable";
  if (styleName) return "style";
  return "hardcoded";
}

function inferPaintRole(node, property) {
  if (node.type === "TEXT") return "text";
  if (property === "stroke") return "border";
  if (
    node.type === "VECTOR" ||
    node.type === "BOOLEAN_OPERATION"
  ) {
    return "icon";
  }
  if (property === "fill") return "surface";
  return "color";
}

async function collectNodes(node, acc, caches, componentName, appearance) {
  if ("visible" in node && node.visible === false) return;

  let currentComponent = componentName;
  if (node.type === "INSTANCE") {
    currentComponent = await resolveInstanceComponent(node, caches.components);
  } else if (node.type === "COMPONENT") {
    currentComponent =
      node.parent && node.parent.type === "COMPONENT_SET"
        ? node.parent.name
        : node.name;
  } else if (node.type === "COMPONENT_SET") {
    currentComponent = node.name;
  }

  const paints = getSolidPaints(node);

  for (const item of paints) {
    const hex = rgbToHex(item.color.r, item.color.g, item.color.b);
    const opacity = item.opacity;
    const colorIdentity = colorKey(hex, opacity);
    const role = inferPaintRole(node, item.property);
    const key = `${colorIdentity}|${role}`;
    const variableId = getVariableId(item.paint);
    const styleId =
      typeof item.styleId === "string" ? item.styleId : "";
    const variableKey = variableId ? `variable:${variableId}` : "";
    const styleKey = styleId ? `style:${styleId}` : "";
    const variableName = await resolveVariableName(variableId, caches.variables);
    const styleName = await resolveStyleName(styleId, caches.styles);
    const binding = bindingType(variableId, styleName);
    const oklab = rgbToOklab(item.color.r, item.color.g, item.color.b);

    let row = acc.get(key);
    if (!row) {
      row = {
        colorKey: colorIdentity,
        role,
        hex,
        opacity,
        uses: 0,
        properties: [],
        bindings: [],
        variables: [],
        styles: [],
        nodes: [],
        components: [],
        nodeTypes: [],
        tokenRefs: [],
        appearances: [],
        L: oklab.L,
        a: oklab.a,
        b: oklab.b
      };
      acc.set(key, row);
    }

    row.uses += 1;
    addUnique(row.properties, item.property);
    addUnique(row.bindings, binding);
    addUnique(row.variables, variableName);
    addUnique(row.styles, styleName);
    if (variableId) {
      addTokenRef(row.tokenRefs, {
        key: variableKey,
        type: "variable",
        id: variableId,
        name: variableName || variableId
      });
    }
    if (styleId) {
      addTokenRef(row.tokenRefs, {
        key: styleKey,
        type: "style",
        id: styleId,
        name: styleName || styleId
      });
    }
    if (row.nodes.length < NODE_NAME_LIMIT) {
      addUnique(row.nodes, node.name || "(unnamed)");
    }
    addUnique(row.nodeTypes, node.type);
    addUnique(row.appearances, appearance);
    if (currentComponent && row.components.length < COMPONENT_NAME_LIMIT) {
      addUnique(row.components, currentComponent);
    }
  }

  if ("children" in node) {
    for (const child of node.children) {
      await collectNodes(child, acc, caches, currentComponent, appearance);
    }
  }
}

function serializeColors(acc, assignments) {
  return Array.from(acc.values()).map((color) => {
    const key = color.colorKey || colorKey(color.hex, color.opacity);
    return {
      key,
      colorKey: key,
      role: color.role || inferRowRole(color),
      palette: assignments[key] || "Unassigned",
      hex: color.hex,
      opacity: color.opacity,
      uses: color.uses,
      lightness: Number(color.L.toFixed(4)),
      chroma: Number(chromaOf(color).toFixed(4)),
      hue: Number(hueOf(color).toFixed(1)),
      properties: color.properties.slice(),
      bindings: color.bindings.slice(),
      variables: color.variables.slice(),
      styles: color.styles.slice(),
      components: color.components.slice(),
      nodes: color.nodes.slice(),
      nodeTypes: color.nodeTypes.slice(),
      tokenRefs: color.tokenRefs.slice(),
      appearances: color.appearances.slice()
    };
  });
}

function aggregatePreviewSources(sources, assignments) {
  const map = new Map();
  sources.forEach((source) => {
    source.rows.forEach((incoming) => {
      const previewKey = `${incoming.key}|${incoming.role || inferRowRole(incoming)}`;
      let row = map.get(previewKey);
      if (!row) {
        row = {
          ...incoming,
          key: previewKey,
          colorKey: incoming.key,
          uses: 0,
          properties: [],
          bindings: [],
          variables: [],
          styles: [],
          components: [],
          nodes: [],
          nodeTypes: [],
          tokenRefs: [],
          appearances: [],
          sources: []
        };
        map.set(previewKey, row);
      }
      row.uses += Number(incoming.uses) || 0;
      row.palette = assignments[incoming.key] || "Unassigned";
      mergeUnique(row.properties, incoming.properties);
      mergeUnique(row.bindings, incoming.bindings);
      mergeUnique(row.variables, incoming.variables);
      mergeUnique(row.styles, incoming.styles);
      mergeUnique(row.components, incoming.components);
      mergeUnique(row.nodes, incoming.nodes);
      mergeUnique(row.nodeTypes, incoming.nodeTypes);
      mergeUnique(row.appearances, incoming.appearances);
      (incoming.tokenRefs || []).forEach((ref) => {
        addTokenRef(row.tokenRefs, ref);
      });
      addUnique(row.sources, source.name);
    });
  });
  return Array.from(map.values());
}

async function analyzeSelection(requestedAppearance) {
  const selection = figma.currentPage.selection;
  const appearance = String(requestedAppearance || "").toLowerCase();

  if (!selection.length) {
    figma.notify("Select at least one frame or screen");
    figma.ui.postMessage({ type: "empty-selection" });
    return;
  }

  if (appearance !== "light" && appearance !== "dark") {
    figma.notify("Choose Light or Dark before Analyze");
    return;
  }

  const database = await getDatabase();
  const assignments =
    (await figma.clientStorage.getAsync(ASSIGNMENTS_STORAGE_KEY)) || {};
  const caches = {
    variables: new Map(),
    styles: new Map(),
    components: new Map()
  };

  const sources = [];
  for (const node of selection) {
    const acc = new Map();
    const rootContext =
      node.type === "INSTANCE" ||
      node.type === "COMPONENT" ||
      node.type === "COMPONENT_SET"
        ? ""
        : node.name || "Selection";
    await collectNodes(node, acc, caches, rootContext, appearance);
    const fileIdentity = figma.fileKey || figma.root.name || "local-file";
    sources.push({
      id: `${fileIdentity}:${node.id}:${appearance}`,
      name: node.name || "Selection",
      fileName: figma.root.name || "",
      pageName: figma.currentPage.name || "",
      rows: serializeColors(acc, assignments)
    });
  }

  const rows = aggregatePreviewSources(sources, assignments);
  rows.sort((a, b) => {
    const pa = paletteRank(a.palette);
    const pb = paletteRank(b.palette);
    if (pa !== pb) return pa - pb;
    return b.lightness - a.lightness;
  });

  const counts = {};
  PALETTE_ORDER.forEach((palette) => {
    counts[palette] = 0;
  });
  rows.forEach((row) => {
    if (counts[row.palette] == null) counts[row.palette] = 0;
    counts[row.palette] += 1;
  });

  lastAnalysis = {
    sources,
    rows
  };

  figma.ui.postMessage({
    type: "result",
    frameCount: selection.length,
    uniqueCount: rows.length,
    counts,
    rows
  });

  figma.notify(
    `${rows.length} colors · ${counts.Unassigned} unassigned`
  );
}
