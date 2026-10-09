import minecraftData from 'minecraft-data';
import { ping, type PingOptions, type NewPingResult, type OldPingResult } from 'minecraft-protocol';
import { createBot, type Bot, type BotOptions } from 'mineflayer';

// Vanilla 1.21/1.21.1 uses protocol 767. Later releases share the "1.21"
// majorVersion key in minecraft-data but have different recipe packet layouts.
const RECIPE_PROTOCOL = 767;
const RECIPE_SERIALIZERS = [
  'crafting_shaped', 'crafting_shapeless', 'crafting_special_armordye',
  'crafting_special_bookcloning', 'crafting_special_mapcloning',
  'crafting_special_mapextending', 'crafting_special_firework_rocket',
  'crafting_special_firework_star', 'crafting_special_firework_star_fade',
  'crafting_special_tippedarrow', 'crafting_special_bannerduplicate',
  'crafting_special_shielddecoration', 'crafting_special_shulkerboxcoloring',
  'crafting_special_suspiciousstew', 'crafting_special_repairitem', 'smelting',
  'blasting', 'smoking', 'campfire_cooking', 'stonecutting', 'smithing_transform',
  'smithing_trim', 'crafting_decorated_pot',
].map((name) => `minecraft:${name}`);
const REMOVED_SERIALIZER = 'minecraft:crafting_special_banneraddpattern';
const MAPPER_NAME = 'LayaRecipeSerializerProtocol767';

type ObjectValue = Record<string, unknown>;
export interface ProtocolCompatibility {
  version: string;
  customPackets?: Record<string, unknown>;
  corrections: string[];
}
export interface CompatibilityDependencies {
  ping?: (options: PingOptions) => Promise<NewPingResult | OldPingResult>;
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unrecognized protocol 767 recipe schema.');
  return value as ObjectValue;
}
function typeArgument(value: unknown, name: string): unknown {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== name) throw new Error('Unrecognized protocol 767 recipe schema.');
  return value[1];
}
function fields(value: unknown): ObjectValue[] {
  const list = typeArgument(value, 'container');
  if (!Array.isArray(list)) throw new Error('Unrecognized protocol 767 recipe schema.');
  return list.map(object);
}
function field(list: ObjectValue[], name: string): ObjectValue {
  const value = list.find((entry) => entry.name === name);
  if (!value) throw new Error('Unrecognized protocol 767 recipe schema.');
  return value;
}
function sameMapping(mapping: ObjectValue, names: string[]): boolean {
  return Object.keys(mapping).length === names.length && names.every((name, index) => mapping[index] === name);
}

/**
 * Return a public customPackets option; never mutate the installed data or
 * replace runtime methods. The packet's existing field codecs remain intact.
 *
 * Upstream data includes a removed serializer at ID 11, shifting all later
 * recipe IDs. A stonecutting recipe is consequently read as campfire cooking,
 * and the resulting offset can fail much later in SlotComponent/ArmorTrimMaterial.
 * Sources: PrismarineJS/minecraft-data data/pc/1.21.1/proto.yml and Minecraft
 * 1.21.1 RecipeSerializer.java (vanilla registry order).
 *
 * Call before constructing the first client for this version. minecraft-protocol
 * caches compiled codecs by version; each production worker has its own process.
 */
export function protocolCompatibility(version: string): ProtocolCompatibility {
  const data = minecraftData(version);
  if (!data) throw new Error(`Minecraft version data is unavailable: ${version}.`);
  const result: ProtocolCompatibility = { version, corrections: [] };
  if (data.version.version !== RECIPE_PROTOCOL) return result;

  const protocol = object(data.protocol);
  const types = object(object(object(protocol.play).toClient).types);
  const declaration = structuredClone(types.packet_declare_recipes);
  const recipeArray = object(typeArgument(field(fields(declaration), 'recipes').type, 'array'));
  const serializer = field(fields(recipeArray.type), 'type');
  // Already supplied through this helper in this process: do not overwrite it.
  if (serializer.type === MAPPER_NAME) return result;
  const mapping = object(object(typeArgument(serializer.type, 'mapper')).mappings);
  if (sameMapping(mapping, RECIPE_SERIALIZERS)) return result; // Future upstream fix.
  const knownIncorrect = [...RECIPE_SERIALIZERS];
  knownIncorrect.splice(11, 0, REMOVED_SERIALIZER);
  if (!sameMapping(mapping, knownIncorrect)) throw new Error('Unverified protocol 767 recipe serializer IDs; refusing to guess a decoder.');
  if (!data.version.majorVersion) throw new Error('Protocol 767 data does not identify its major version.');

  // lodash.merge, used by the public option, merges arrays and mapper objects.
  // A fresh named mapper prevents the obsolete final ID from being retained.
  serializer.type = MAPPER_NAME;
  const correctedMapper = ['mapper', { type: 'varint', mappings: Object.fromEntries(RECIPE_SERIALIZERS.map((name, index) => [index, name])) }];
  result.customPackets = {
    [data.version.majorVersion]: {
      play: { toClient: { types: { packet_declare_recipes: declaration, [MAPPER_NAME]: correctedMapper } } },
    },
  };
  result.corrections.push('protocol-767-recipe-serializer-ids');
  return result;
}

/** Resolve auto negotiation before applying a version-specific public codec. */
export async function resolveBotCompatibility(options: BotOptions, dependencies: CompatibilityDependencies = {}): Promise<BotOptions> {
  if (options.customPackets) throw new Error('Caller customPackets cannot be combined with the validated compatibility decoder.');
  let version = options.version;
  if (!version) {
    if (options.client || options.stream || options.connect) throw new Error('Automatic compatibility detection requires a normal Minecraft host/port connection.');
    const status = await (dependencies.ping ?? ping)({
      host: options.host ?? '127.0.0.1', port: options.port ?? 25566,
      closeTimeout: Math.min(options.closeTimeout ?? 5000, 5000), noPongTimeout: 1000,
    });
    const protocol = 'protocol' in status ? status.protocol : status.version.protocol;
    if (!Number.isInteger(protocol)) throw new Error('Minecraft status did not identify a protocol version.');
    const data = minecraftData(protocol);
    if (!data || data.version.version !== protocol) throw new Error(`Minecraft protocol ${protocol} is unsupported by the installed version data.`);
    version = data.version.minecraftVersion;
  }
  if (!version) throw new Error('Minecraft version data does not identify a release version.');
  const compatibility = protocolCompatibility(version);
  return { ...options, version, ...(compatibility.customPackets ? { customPackets: compatibility.customPackets } : {}) };
}

export async function createCompatibleBot(options: BotOptions, dependencies: CompatibilityDependencies = {}): Promise<Bot> {
  return createBot(await resolveBotCompatibility(options, dependencies));
}
