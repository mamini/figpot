import dns from 'node:dns';

import { checkbox, input, select } from '@inquirer/prompts';

import {
  ApiError,
  ErrorResponsePayloadWithErrorBoolean,
  GetFileNodesResponse,
  GetFileResponse,
  GetLocalVariablesResponse,
  LocalVariable,
  Paint,
  RGBA,
  SubcanvasNode,
  TypeStyle,
  VariableAlias,
  getFile,
  getFileNodes,
  getProjectFiles,
  getTeamProjects,
} from '@figpot/src/clients/figma';
import { DocumentOptionsType, ExcludePatternsType, ReplaceFontPatternType } from '@figpot/src/features/document';
import { config } from '@figpot/src/utils/environment';
import { workaroundAssert as assert } from '@figpot/src/utils/assert';

export type FigmaDefinedTypography = {
  id: LocalVariable['id'];
  key: LocalVariable['key'];
  name: LocalVariable['name'];
  description: LocalVariable['description'];
  value: TypeStyle;
};

export type FigmaDefinedColor = {
  id: LocalVariable['id'];
  key: LocalVariable['key'];
  name: LocalVariable['name'];
  description: LocalVariable['description'];
  value?: Paint;
};

export function isColor(value: string | number | boolean | RGBA | VariableAlias): value is RGBA {
  return typeof value === 'object' && 'r' in value;
}

export function processDocumentsParametersFromInput(parameters: string[]): DocumentOptionsType[] {
  return parameters.map((parameter) => {
    const parts = parameter.split(':');

    return {
      figmaDocument: parts[0],
      penpotDocument: parts[1], // May be undefined if the user wants a new Penpot document
    };
  });
}

export async function retrieveStylesNodes(documentId: string, stylesIds: string[]): Promise<GetFileNodesResponse['nodes']> {
  if (!stylesIds.length) {
    return {};
  }

  const nodes: GetFileNodesResponse['nodes'] = {};

  // Figma gateway has URL length limit that is reached when having too many styles
  // So we need to chunk according to this limit to minize calls (have to do it step by step because each entry has a different length)
  // Ref: https://stackoverflow.com/a/40250849/3608410
  // Note: styles types `GRID` and `EFFECT` are most of the time a few, so no removing them for retrieval for future use
  const urlLengthLimitBytes = 8_192;
  const remainingBytesPerRequest = urlLengthLimitBytes - `https://api.figma.com/v1/files/${documentId}/nodes?depth=1&ids=`.length - 10; // We add a safe marging of 10 in case of specific default adding

  // [IMPORTANT] The generated Figma client is encoding all query parameters so we need to take this into account for `:` and `,`
  const delimiterLength = encodeURIComponent(',').length;

  const chunks: string[][] = [[]];
  let currentChunkIndex = 0;
  let currentChunkCount = 0;
  for (const styleId of stylesIds) {
    const encodedStyleIdLength = encodeURIComponent(styleId).length;

    // Take into account the `,` delimiter
    if (currentChunkCount + Math.max(chunks[currentChunkIndex].length - 1, 0) * delimiterLength + encodedStyleIdLength > remainingBytesPerRequest) {
      chunks.push([]);
      currentChunkIndex++;
      currentChunkCount = 0;
    }

    chunks[currentChunkIndex].push(styleId);
    currentChunkCount += encodedStyleIdLength;
  }

  for (const stylesIds of chunks) {
    const response = await getFileNodes({
      fileKey: documentId,
      ids: stylesIds.join(','),
      depth: 1, // Should only return styles but just in case...
    });

    // Merge nodes objects
    Object.assign(nodes, response.nodes);
  }

  return nodes;
}

export async function retrieveColors(documentId: string): Promise<FigmaDefinedColor[]> {
  const colors: FigmaDefinedColor[] = [];

  // The generated client intermittently times out for this endpoint in local source runs, while a direct fetch is stable.
  dns.setDefaultResultOrder('ipv4first');

  const response = await fetch(`https://api.figma.com/v1/files/${encodeURIComponent(documentId)}/variables/local`, {
    headers: {
      Accept: 'application/json',
      'X-Figma-Token': config.figmaAccessToken,
    },
  });

  const responseBody = (await response.json().catch(() => undefined)) as GetLocalVariablesResponse | ErrorResponsePayloadWithErrorBoolean | undefined;

  if (!response.ok) {
    const message = typeof responseBody === 'object' && responseBody && 'message' in responseBody ? responseBody.message : undefined;
    const lowerMessage = typeof message === 'string' ? message.toLowerCase() : '';

    if (response.status === 403 && (lowerMessage.includes('file_variables:read') || lowerMessage.includes('limited by figma plan'))) {
      console.warn(
        `exact color variables names won't be transferred since Figma requires the most expensive plan just to get variables you defined (Enterprise plan you seem to not have)...`
      );
      return colors;
    }

    const error = new Error(typeof message === 'string' ? message : `failed to retrieve local Figma variables (status ${response.status})`);
    (error as Error & { status?: number; body?: unknown }).status = response.status;
    (error as Error & { status?: number; body?: unknown }).body = responseBody;
    throw error;
  }

  const localVariablesResult = responseBody as GetLocalVariablesResponse;
  for (const localVariable of Object.values(localVariablesResult.meta.variables)) {
    if (localVariable.resolvedType === 'COLOR') {
      // TODO: variables can be nested, it should be taken into account to also make sure what happens if the nested variable is into another file
      // We rely on a value if provided by using the default Figma mode, and when it's not available The easier for us is to set the value from the hardcoded values of nodes (may be a problem in some cases if multiple mode applied, but it's unlikely)
      // Ref: https://forum.figma.com/t/how-to-access-variable-alias-value-from-another-collection/53203/4
      const collection = localVariablesResult.meta.variableCollections[localVariable.variableCollectionId];

      colors.push({
        id: localVariable.id,
        key: localVariable.key,
        name: localVariable.name,
        description: localVariable.description,
        value:
          !!collection &&
          localVariable.valuesByMode[collection.defaultModeId] !== undefined &&
          isColor(localVariable.valuesByMode[collection.defaultModeId])
            ? {
                // Color variables can only manage a simple color so emulating to the appropriate Paint one
                type: 'SOLID',
                color: localVariable.valuesByMode[collection.defaultModeId] as RGBA,
                blendMode: 'NORMAL',
              }
            : undefined,
      });
    }
  }

  return colors;
}

export function mergeStylesColors(colors: FigmaDefinedColor[], documentTree: GetFileResponse, stylesNodes: GetFileNodesResponse['nodes']) {
  for (const [, styleNode] of Object.entries(stylesNodes)) {
    if (documentTree.styles[styleNode.document.id]?.styleType === 'FILL' && styleNode.document.type === 'RECTANGLE') {
      // A Figma style can contains multiple colors so we have to split them to fit with the Penpot logic of "1 style = 1 color"
      for (let i = 0; i < styleNode.document.fills.length; i++) {
        colors.push({
          id: styleNode.document.fills.length > 1 ? `${styleNode.document.id}_${i}` : styleNode.document.id, // Add a suffix to differentiate them if needed
          key: documentTree.styles[styleNode.document.id].key,
          name:
            styleNode.document.fills.length > 1
              ? `${documentTree.styles[styleNode.document.id].name} ${i + 1}`
              : documentTree.styles[styleNode.document.id].name,
          description: documentTree.styles[styleNode.document.id].description,
          value: styleNode.document.fills[i],
        });
      }
    }
  }
}

export function extractStylesTypographies(documentTree: GetFileResponse, stylesNodes: GetFileNodesResponse['nodes']): FigmaDefinedTypography[] {
  const typographies: FigmaDefinedTypography[] = [];

  for (const [, styleNode] of Object.entries(stylesNodes)) {
    if (documentTree.styles[styleNode.document.id]?.styleType === 'TEXT' && styleNode.document.type === 'TEXT') {
      typographies.push({
        id: styleNode.document.id,
        key: documentTree.styles[styleNode.document.id].key,
        name: documentTree.styles[styleNode.document.id].name,
        description: documentTree.styles[styleNode.document.id].description,
        value: styleNode.document.style,
      });
    }
  }

  return typographies;
}

export function countNestedTreeElements(figmaNode: SubcanvasNode): number {
  let childrenCount = 0;

  // Deep parse
  if ('children' in figmaNode) {
    childrenCount += figmaNode.children.length;

    for (const childNode of figmaNode.children) {
      childrenCount += countNestedTreeElements(childNode);
    }
  }

  return childrenCount;
}

export function countTotalElements(tree: GetFileResponse, colors: FigmaDefinedColor[], typographies: FigmaDefinedTypography[]): number {
  let treeCount = tree.document.children.length;

  for (const canvas of tree.document.children) {
    treeCount += canvas.children.length;

    for (const node of canvas.children) {
      treeCount += countNestedTreeElements(node);
    }
  }

  return treeCount + colors.length + typographies.length;
}

// Reverse of the suffix→weight table in `translateFontWeight`: given a weight + style, produce a PostScript suffix that `extractFontFamilySuffix` will recognize
const FONT_WEIGHT_POST_SCRIPT_SUFFIX: Record<number, { normal: string; italic: string }> = {
  100: { normal: 'Thin', italic: 'ThinItalic' },
  200: { normal: 'ExtraLight', italic: 'ExtraLightItalic' },
  300: { normal: 'Light', italic: 'LightItalic' },
  400: { normal: 'Regular', italic: 'Italic' },
  500: { normal: 'Medium', italic: 'MediumItalic' },
  600: { normal: 'SemiBold', italic: 'SemiBoldItalic' },
  700: { normal: 'Bold', italic: 'BoldItalic' },
  800: { normal: 'ExtraBold', italic: 'ExtraBoldItalic' },
  900: { normal: 'Black', italic: 'BlackItalic' },
};

export function patchFontFamily(fontSettings: TypeStyle, replaceFontPatterns: ReplaceFontPatternType[]) {
  if (!fontSettings.fontFamily) {
    return;
  }

  for (const replaceFontPattern of replaceFontPatterns) {
    // Test against both fontFamily and fontPostScriptName so users can target either side (Figma sometimes exposes the variant name only via the PostScript field)
    const matchesFamily = replaceFontPattern.search.test(fontSettings.fontFamily);
    const matchesPostScript = !!fontSettings.fontPostScriptName && replaceFontPattern.search.test(fontSettings.fontPostScriptName);
    if (!matchesFamily && !matchesPostScript) {
      continue;
    }

    fontSettings.fontFamily = replaceFontPattern.set;

    // Allow forcing a weight/style so a Figma single-weight variant (e.g. "Arial-Black" at 900) can land on a differently-registered Penpot font (e.g. "Arial Black" at 400)
    if (replaceFontPattern.setStyle !== undefined) {
      fontSettings.italic = replaceFontPattern.setStyle === 'italic';
    }
    if (replaceFontPattern.setWeight !== undefined) {
      fontSettings.fontWeight = replaceFontPattern.setWeight;
      // `translateFontWeight` ignores `fontWeight` and derives the weight from the PostScript suffix, so we also synthesize a PostScript name whose suffix maps back to the forced weight
      const postScriptSuffix = FONT_WEIGHT_POST_SCRIPT_SUFFIX[replaceFontPattern.setWeight]?.[fontSettings.italic === true ? 'italic' : 'normal'];
      if (postScriptSuffix) {
        fontSettings.fontPostScriptName = postScriptSuffix;
      }
    }

    return;
  }
}

export function patchNestedTreeElements(
  figmaNode: SubcanvasNode,
  excludePatterns: ExcludePatternsType,
  replaceFontPatterns: ReplaceFontPatternType[]
) {
  // Deep parse
  // Note: arrays are browsed the reverse order since modifying it while browsing
  if ('children' in figmaNode) {
    let w = figmaNode.children.length;
    while (w--) {
      if (excludePatterns.nodeNamePatterns && excludePatterns.nodeNamePatterns.some((pattern) => pattern.test(figmaNode.children[w].name))) {
        figmaNode.children.splice(w, 1);
      } else {
        patchNestedTreeElements(figmaNode.children[w], excludePatterns, replaceFontPatterns);
      }
    }
  }

  // Patch the font if needed
  if (figmaNode.type === 'TEXT' && replaceFontPatterns.length > 0) {
    patchFontFamily(figmaNode.style, replaceFontPatterns);

    for (const segmentStyle of Object.values(figmaNode.styleOverrideTable)) {
      patchFontFamily(segmentStyle, replaceFontPatterns);
    }
  }
}

export function patchDocument(
  documentTree: GetFileResponse,
  definedColors: FigmaDefinedColor[],
  definedTypographies: FigmaDefinedTypography[],
  excludePatterns: ExcludePatternsType,
  replaceFontPatterns: ReplaceFontPatternType[]
) {
  // Here we apply `excludePatterns` settings
  // Note: arrays are browsed the reverse order since modifying it while browsing
  let v = documentTree.document.children.length;
  while (v--) {
    const canvas = documentTree.document.children[v];

    if (excludePatterns.pageNamePatterns && excludePatterns.pageNamePatterns.some((pattern) => pattern.test(canvas.name))) {
      documentTree.document.children.splice(v, 1);
    } else {
      let w = canvas.children.length;
      while (w--) {
        if (excludePatterns.nodeNamePatterns && excludePatterns.nodeNamePatterns.some((pattern) => pattern.test(canvas.children[w].name))) {
          canvas.children.splice(w, 1);
        } else {
          patchNestedTreeElements(canvas.children[w], excludePatterns, replaceFontPatterns);
        }
      }
    }
  }

  if (excludePatterns.componentNamePatterns) {
    for (const [componentId, component] of Object.entries(documentTree.components)) {
      if (excludePatterns.componentNamePatterns.some((pattern) => pattern.test(component.name))) {
        delete documentTree.components[componentId];
      }
    }

    for (const [componentSetId, componentSet] of Object.entries(documentTree.componentSets)) {
      if (excludePatterns.componentNamePatterns.some((pattern) => pattern.test(componentSet.name))) {
        delete documentTree.componentSets[componentSetId];
      }
    }
  }

  if (excludePatterns.typographyNamePatterns) {
    let i = definedTypographies.length;
    while (i--) {
      if (excludePatterns.typographyNamePatterns.some((pattern) => pattern.test(definedTypographies[i].name))) {
        definedTypographies.splice(i, 1);
      }
    }
  }

  if (excludePatterns.colorNamePatterns) {
    let u = definedColors.length;
    while (u--) {
      if (excludePatterns.colorNamePatterns.some((pattern) => pattern.test(definedColors[u].name))) {
        definedColors.splice(u, 1);
      }
    }
  }

  // Patch the fonts if needed
  if (replaceFontPatterns.length > 0) {
    for (const definedTypography of definedTypographies) {
      patchFontFamily(definedTypography.value, replaceFontPatterns);
    }
  }
}

export async function retrieveShallowDocument(documentId: string): Promise<GetFileResponse> {
  // depth=1 returns page stubs (id + name) + all document-level metadata
  // (components, componentSets, styles) without any page content. Used in
  // per-page mode so the full multi-GB tree is never fetched as a whole.
  return await getFile({ fileKey: documentId, depth: 1 });
}

/**
 * Fetches a single Figma page with full geometry, with retry logic for transient
 * network errors. Returns the raw API response (which includes all doc-level
 * metadata: components, componentSets, styles) or undefined if all retries fail.
 */
export async function fetchSinglePageContent(fileKey: string, pageId: string): Promise<GetFileResponse | undefined> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await getFile({ fileKey, ids: pageId, geometry: 'paths' });
      if (result) return result;
      const maxNoDataAttempts = 2;
      if (attempt < maxNoDataAttempts) {
        const delay = attempt * 5000;
        console.warn(`    Attempt ${attempt} returned no data; retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.warn(`    Page "${pageId}" returned no data after ${attempt} attempt(s) — skipping.`);
        return undefined;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isTransient = /ECONNRESET|fetch failed|terminated|ETIMEDOUT|ECONNABORTED/i.test(msg);
      if (isTransient && attempt < maxAttempts) {
        const delay = attempt * 5000;
        console.warn(`    Attempt ${attempt}/${maxAttempts} failed (${msg}); retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      } else if (isTransient) {
        console.warn(`    All ${maxAttempts} attempts failed for page "${pageId}" — proceeding without geometry.`);
        return undefined;
      } else {
        throw error;
      }
    }
  }
  return undefined;
}

export async function retrieveDocument(documentId: string) {
  // First attempt: full file in one request (works for small/medium files)
  try {
    const documentTree = await getFile({
      fileKey: documentId,
      geometry: 'paths', // Needed to have all properties into nodes
    });
    return documentTree;
  } catch (error) {
    // Fall through to page-by-page strategy when:
    //  - Figma returns 400 "Request too large"
    //  - The connection is reset (ECONNRESET) because the response body is too large
    const is400 = error instanceof ApiError && error.status === 400;
    const isConnReset = error instanceof TypeError && /ECONNRESET|fetch failed|terminated/i.test(error.message);
    if (!is400 && !isConnReset) {
      throw error;
    }
    const reason = is400 ? '400 (file too large)' : `network error (${(error as Error).message})`;
    console.warn(`Full file fetch returned ${reason}; falling back to page-by-page fetch with geometry=paths...`);
  }

  // Fallback: fetch pages one at a time to stay within Figma's size limit.
  // Step 1: get the document tree at depth=1 (just page nodes, no children) for metadata + page IDs.
  const shallowTree = await getFile({
    fileKey: documentId,
    depth: 1,
  });

  const pageIds = shallowTree.document.children.map((page) => page.id);
  console.log(`Fetching ${pageIds.length} page(s) individually with geometry...`);

  // Step 2: fetch each page with full depth + geometry, one at a time to respect Figma's
  // Tier 2 monthly quota (parallel requests exhaust the quota immediately).
  // Large pages can cause ECONNRESET either during the fetch or during body streaming, so
  // we retry transient network failures with exponential back-off.
  const pageResults: (Awaited<ReturnType<typeof getFile>> | undefined)[] = [];
  for (let i = 0; i < pageIds.length; i++) {
    const pageId = pageIds[i];
    console.log(`  Fetching page ${i + 1}/${pageIds.length} (id: ${pageId})...`);
    let result: Awaited<ReturnType<typeof getFile>> | undefined;
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        result = await getFile({
          fileKey: documentId,
          ids: pageId,
          geometry: 'paths',
        });
        if (result) break; // success — exit retry loop
        // getResponseBody silently returns undefined when the server closes the connection
        // mid-stream (page is too large for the API to fully deliver). Only retry once —
        // if it fails repeatedly the page is simply oversized and retrying wastes time.
        const maxNoDataAttempts = 2;
        if (attempt < maxNoDataAttempts) {
          const delay = attempt * 5000;
          console.warn(`    Attempt ${attempt}/${maxNoDataAttempts} returned no data; retrying in ${delay / 1000}s...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          console.warn(`    Returned no data after ${attempt} attempt(s); page is likely too large — proceeding without geometry.`);
          break;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isTransient = /ECONNRESET|fetch failed|terminated|ETIMEDOUT|ECONNABORTED/i.test(msg);
        if (isTransient && attempt < maxAttempts) {
          const delay = attempt * 5000;
          console.warn(`    Attempt ${attempt}/${maxAttempts} failed (${msg}); retrying in ${delay / 1000}s...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else if (isTransient) {
          // All retries exhausted for a transient error — fall back to shallow page
          console.warn(`    All ${maxAttempts} attempts failed; proceeding without geometry for this page.`);
          result = undefined;
          break;
        } else {
          throw error; // non-transient (auth, 404, etc.) — propagate immediately
        }
      }
    }
    pageResults.push(result);
    // Small pause between requests to stay inside Figma's per-minute burst window
    if (i < pageIds.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  // Step 3: merge page children back into the shallow document tree.
  // When getFile is called with `ids=pageId`, the API returns all top-level canvas nodes
  // (Figma quirk) but only the requested page has its subtree populated.
  //
  // `getResponseBody` in the generated client silently returns `undefined` when the HTTP
  // response JSON fails to parse (e.g. a very large page causes an OOM or stream error).
  // Guard against that so we fall back to the shallow (no-geometry) page node rather
  // than crashing on `result.document`.
  const mergedChildren = shallowTree.document.children.map((shallowPage, i) => {
    const result = pageResults[i];
    if (!result?.document?.children) {
      console.warn(
        `  Warning: page ${i + 1}/${pageIds.length} (id: ${pageIds[i]}, name: "${shallowPage.name}") returned no usable data; proceeding without geometry for this page.`
      );
      return shallowPage;
    }
    const fullPage = result.document.children.find((p) => p.id === shallowPage.id);
    return fullPage ?? shallowPage;
  });

  // Merge components, componentSets, styles across all per-page responses.
  const components = { ...shallowTree.components };
  const componentSets = { ...shallowTree.componentSets };
  const styles = { ...shallowTree.styles };
  for (const result of pageResults) {
    if (!result) continue;
    Object.assign(components, result.components);
    Object.assign(componentSets, result.componentSets);
    Object.assign(styles, result.styles);
  }

  return {
    ...shallowTree,
    document: {
      ...shallowTree.document,
      children: mergedChildren,
    },
    components,
    componentSets,
    styles,
  };
}

export async function retrieveDocumentsFromInput(): Promise<string[]> {
  // Teams cannot be gotten so expecting the user to precise it
  const teamId = await input({ message: 'What is the team ID to list the documents from? (you can see it inside the URL once on Figma)' });
  const teamAndProjects = await getTeamProjects({ teamId: teamId });

  const projectId = await select({
    message: `Inside the team "${teamAndProjects.name}", select the project to list documents from`,
    choices: teamAndProjects.projects.map((project) => {
      return {
        name: project.name,
        value: project.id,
        description: `(${project.id})`,
      };
    }),
  });

  const project = teamAndProjects.projects.find((p) => p.id === projectId);
  assert(project);

  const projectAndFiles = await getProjectFiles({ projectId: projectId });

  const documentsKeys = await checkbox({
    message: `Inside the project "${project.name}", select the documents to synchronize into Penpot`,
    choices: projectAndFiles.files.map((file) => {
      return {
        name: file.name,
        value: file.key,
        description: `(${file.key})`,
      };
    }),
  });

  if (!documentsKeys.length) {
    throw new Error('you should have selected at least a document');
  }

  return documentsKeys;
}
