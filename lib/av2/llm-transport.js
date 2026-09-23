import Ajv2020 from "ajv/dist/2020.js";
import { CreativeValidationError, EPISODE_PLAN_SCHEMA } from "./contracts.js";

export const AV2_LLM_EPISODE_TRANSPORT_VERSION = "av2-llm-episode-transport/1";
export const AV2_LLM_EPISODE_TRANSPORT_SCHEMA_NAME = "av2_llm_episode_transport_v1";

const UNSUPPORTED_OPENAI_KEYWORDS = new Set([
  "$schema", "$id", "default", "allOf", "not", "dependentRequired", "dependentSchemas",
  "if", "then", "else", "patternProperties", "uniqueItems", "minProperties", "maxProperties",
]);

const continuityInitialSchema = EPISODE_PLAN_SCHEMA.properties.episode.properties.continuity_initial;
const actionParametersSchema = EPISODE_PLAN_SCHEMA.$defs.scene.properties.actions.items.properties.parameters;
const effectParametersSchema = EPISODE_PLAN_SCHEMA.$defs.scene.properties.effects.items.properties.parameters;
const assertionExpectedSchema = EPISODE_PLAN_SCHEMA.$defs.scene.properties.assertions.items.properties.expected;
const stateRuleValueSchema = EPISODE_PLAN_SCHEMA.$defs.stateRule.properties.value;
const OPEN_MAP_SCHEMAS = new Set([continuityInitialSchema, actionParametersSchema, effectParametersSchema]);
const OPEN_VALUE_SCHEMAS = new Set([assertionExpectedSchema, stateRuleValueSchema]);

const scalarVariants = [
  ["string", { value: { type: "string" } }],
  ["number", { value: { type: "number" } }],
  ["boolean", { value: { type: "boolean" } }],
  ["null", {}],
];

function closedVariant(kind, properties) {
  return {
    type: "object",
    additionalProperties: false,
    properties: { kind: { const: kind }, ...properties },
    required: ["kind", ...Object.keys(properties)],
  };
}

const transportScalarValue = {
  anyOf: scalarVariants.map(([kind, properties]) => closedVariant(kind, properties)),
};

const transportValue = {
  anyOf: [
    ...scalarVariants.map(([kind, properties]) => closedVariant(kind, properties)),
    closedVariant("string_list", { items: { type: "array", items: { type: "string" } } }),
    closedVariant("number_list", { items: { type: "array", items: { type: "number" } } }),
    closedVariant("boolean_list", { items: { type: "array", items: { type: "boolean" } } }),
    closedVariant("object", {
      entries: { type: "array", items: { $ref: "#/$defs/av2_transport_scalar_entry" } },
    }),
  ],
};

const transportEntry = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string", pattern: "^[a-z][a-z0-9_.-]*$" },
    value: { $ref: "#/$defs/av2_transport_value" },
  },
  required: ["key", "value"],
};

const transportScalarEntry = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string", pattern: "^[a-z][a-z0-9_.-]*$" },
    value: { $ref: "#/$defs/av2_transport_scalar_value" },
  },
  required: ["key", "value"],
};

function acceptsNull(schema) {
  return schema?.type === "null"
    || (Array.isArray(schema?.type) && schema.type.includes("null"))
    || schema?.const === null
    || schema?.enum?.includes?.(null)
    || schema?.anyOf?.some?.(acceptsNull);
}

function nullable(schema) {
  return acceptsNull(schema) ? schema : { anyOf: [schema, { type: "null" }] };
}

function transportize(source) {
  if (OPEN_MAP_SCHEMAS.has(source)) {
    const maxItems = Number(source.maxProperties);
    return {
      type: "array",
      ...(Number.isInteger(maxItems) ? { maxItems } : {}),
      items: { $ref: "#/$defs/av2_transport_entry" },
    };
  }
  if (OPEN_VALUE_SCHEMAS.has(source)) return { $ref: "#/$defs/av2_transport_value" };
  if (Array.isArray(source)) return source.map(transportize);
  if (!source || typeof source !== "object") return source;

  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (UNSUPPORTED_OPENAI_KEYWORDS.has(key) || key === "$defs" || key === "title") continue;
    result[key] = transportize(value);
  }
  if (source.type === "object" && source.properties) {
    const domainRequired = new Set(source.required || []);
    result.properties = Object.fromEntries(Object.entries(source.properties).map(([key, value]) => {
      const propertySchema = transportize(value);
      return [key, domainRequired.has(key) ? propertySchema : nullable(propertySchema)];
    }));
    result.required = Object.keys(result.properties);
    result.additionalProperties = false;
  }
  return result;
}

const transportEpisodePlan = transportize(EPISODE_PLAN_SCHEMA);
const transportDefinitions = Object.fromEntries(
  Object.entries(EPISODE_PLAN_SCHEMA.$defs).map(([key, value]) => [key, transportize(value)]),
);

export const AV2_LLM_EPISODE_TRANSPORT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    transport_version: { const: AV2_LLM_EPISODE_TRANSPORT_VERSION },
    episode_plan: transportEpisodePlan,
  },
  required: ["transport_version", "episode_plan"],
  $defs: {
    ...transportDefinitions,
    av2_transport_scalar_value: transportScalarValue,
    av2_transport_value: transportValue,
    av2_transport_scalar_entry: transportScalarEntry,
    av2_transport_entry: transportEntry,
  },
});

function schemaErrors(errors = []) {
  return errors.map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message || "invalid transport value",
    params: error.params,
  }));
}

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, validateFormats: false });
const validateTransportShape = ajv.compile(AV2_LLM_EPISODE_TRANSPORT_SCHEMA);

export function validateEpisodeTransport(value, { throwOnError = true } = {}) {
  const errors = validateTransportShape(value) ? [] : schemaErrors(validateTransportShape.errors);
  if (errors.length && throwOnError) throw new CreativeValidationError("episode_transport_invalid", errors);
  return { ok: errors.length === 0, errors };
}

function resolveDomainSchema(schema) {
  if (!schema?.$ref) return schema;
  const match = schema.$ref.match(/^#\/\$defs\/([^/]+)$/);
  if (!match || !EPISODE_PLAN_SCHEMA.$defs[match[1]]) throw new Error(`Unsupported AV2 schema reference: ${schema.$ref}`);
  return EPISODE_PLAN_SCHEMA.$defs[match[1]];
}

function scalarToDomain(value, path) {
  switch (value.kind) {
    case "string":
    case "number":
    case "boolean": return value.value;
    case "null": return null;
    default: throw new CreativeValidationError("episode_transport_normalization_invalid", [{
      path, keyword: "transport_value", message: `unsupported scalar kind ${value.kind}`, params: {},
    }]);
  }
}

function entriesToObject(entries, path, scalarOnly = false) {
  const result = {};
  for (const [index, entry] of entries.entries()) {
    if (Object.hasOwn(result, entry.key)) {
      throw new CreativeValidationError("episode_transport_normalization_invalid", [{
        path: `${path}/${index}/key`, keyword: "unique", message: `duplicate transport key ${entry.key}`, params: {},
      }]);
    }
    result[entry.key] = scalarOnly
      ? scalarToDomain(entry.value, `${path}/${index}/value`)
      : transportValueToDomain(entry.value, `${path}/${index}/value`);
  }
  return result;
}

function transportValueToDomain(value, path) {
  if (["string", "number", "boolean", "null"].includes(value.kind)) return scalarToDomain(value, path);
  if (["string_list", "number_list", "boolean_list"].includes(value.kind)) return structuredClone(value.items);
  if (value.kind === "object") return entriesToObject(value.entries, `${path}/entries`, true);
  throw new CreativeValidationError("episode_transport_normalization_invalid", [{
    path, keyword: "transport_value", message: `unsupported value kind ${value.kind}`, params: {},
  }]);
}

function normalizeNode(value, rawSchema, path) {
  const schema = resolveDomainSchema(rawSchema);
  if (OPEN_MAP_SCHEMAS.has(schema)) return entriesToObject(value, path);
  if (OPEN_VALUE_SCHEMAS.has(schema)) return transportValueToDomain(value, path);
  if (schema?.type === "array") return value.map((entry, index) => normalizeNode(entry, schema.items, `${path}/${index}`));
  if (schema?.type === "object" && schema.properties) {
    const domainRequired = new Set(schema.required || []);
    const result = {};
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (value[key] === null && !domainRequired.has(key)) continue;
      result[key] = normalizeNode(value[key], propertySchema, `${path}/${key}`);
    }
    return result;
  }
  return structuredClone(value);
}

export function transportToAv2Domain(transport) {
  validateEpisodeTransport(transport);
  return normalizeNode(transport.episode_plan, EPISODE_PLAN_SCHEMA, "/episode_plan");
}

function scalarFromDomain(value, path) {
  if (value === null) return { kind: "null" };
  if (["string", "number", "boolean"].includes(typeof value)) return { kind: typeof value, value };
  throw new Error(`Unsupported nested transport scalar at ${path}`);
}

function transportValueFromDomain(value, path) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return scalarFromDomain(value, path);
  if (Array.isArray(value)) {
    const kinds = new Set(value.map((entry) => typeof entry));
    const kind = !value.length || (kinds.size === 1 && kinds.has("string")) ? "string_list"
      : (kinds.size === 1 && kinds.has("number")) ? "number_list"
        : (kinds.size === 1 && kinds.has("boolean")) ? "boolean_list" : null;
    if (!kind) throw new Error(`Unsupported heterogeneous transport list at ${path}`);
    return { kind, items: structuredClone(value) };
  }
  if (typeof value === "object") {
    return {
      kind: "object",
      entries: Object.entries(value).map(([key, entry]) => ({ key, value: scalarFromDomain(entry, `${path}/${key}`) })),
    };
  }
  throw new Error(`Unsupported transport value at ${path}`);
}

function denormalizeNode(value, rawSchema, path) {
  const schema = resolveDomainSchema(rawSchema);
  if (OPEN_MAP_SCHEMAS.has(schema)) {
    return Object.entries(value).map(([key, entry]) => ({ key, value: transportValueFromDomain(entry, `${path}/${key}`) }));
  }
  if (OPEN_VALUE_SCHEMAS.has(schema)) return transportValueFromDomain(value, path);
  if (schema?.type === "array") return value.map((entry, index) => denormalizeNode(entry, schema.items, `${path}/${index}`));
  if (schema?.type === "object" && schema.properties) {
    const domainRequired = new Set(schema.required || []);
    const result = {};
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key)) {
        if (domainRequired.has(key)) throw new Error(`Missing required domain property ${path}/${key}`);
        result[key] = null;
      } else {
        result[key] = denormalizeNode(value[key], propertySchema, `${path}/${key}`);
      }
    }
    return result;
  }
  return structuredClone(value);
}

export function av2DomainToEpisodeTransport(plan) {
  return {
    transport_version: AV2_LLM_EPISODE_TRANSPORT_VERSION,
    episode_plan: denormalizeNode(plan, EPISODE_PLAN_SCHEMA, "/episode_plan"),
  };
}

export function inspectOpenAIStructuredOutputSchema(schema = AV2_LLM_EPISODE_TRANSPORT_SCHEMA) {
  const errors = [];
  let propertyCount = 0;
  let enumValueCount = 0;
  let maxObjectDepth = 0;
  function walk(node, path = "", objectDepth = 0) {
    if (Array.isArray(node)) return node.forEach((entry, index) => walk(entry, `${path}/${index}`, objectDepth));
    if (!node || typeof node !== "object") return;
    const nextDepth = node.type === "object" ? objectDepth + 1 : objectDepth;
    maxObjectDepth = Math.max(maxObjectDepth, nextDepth);
    for (const key of Object.keys(node)) {
      if (UNSUPPORTED_OPENAI_KEYWORDS.has(key)) errors.push({ path: path || "/", keyword: key });
    }
    if (node.type === "object") {
      if (node.additionalProperties !== false) errors.push({ path: path || "/", keyword: "additionalProperties" });
      const keys = Object.keys(node.properties || {});
      propertyCount += keys.length;
      if (JSON.stringify([...(node.required || [])].sort()) !== JSON.stringify([...keys].sort())) {
        errors.push({ path: path || "/", keyword: "required" });
      }
    }
    if (Array.isArray(node.enum)) enumValueCount += node.enum.length;
    for (const [key, value] of Object.entries(node)) walk(value, `${path}/${key}`, nextDepth);
  }
  walk(schema);
  if (schema.type !== "object") errors.push({ path: "/", keyword: "root_object" });
  if (propertyCount > 5000) errors.push({ path: "/", keyword: "property_limit" });
  if (enumValueCount > 1000) errors.push({ path: "/", keyword: "enum_limit" });
  if (maxObjectDepth > 10) errors.push({ path: "/", keyword: "nesting_limit" });
  return { ok: errors.length === 0, errors, property_count: propertyCount, enum_value_count: enumValueCount, max_object_depth: maxObjectDepth };
}

export function assertOpenAIStructuredOutputSchema(schema = AV2_LLM_EPISODE_TRANSPORT_SCHEMA) {
  const result = inspectOpenAIStructuredOutputSchema(schema);
  if (!result.ok) throw new Error(`OpenAI Structured Outputs schema is incompatible: ${JSON.stringify(result.errors)}`);
  return result;
}
