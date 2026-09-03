/**
 * Aperas Snowflake-style node identity generator.
 *
 * 64-bit layout (see AperasKG/artifacts/Aperas-core-ontology-design.md §1.A):
 *   1  bit  — sign (unused, always 0 — keeps the value a positive signed int64)
 *   45 bits — timestamp, ms since a custom epoch
 *   10 bits — machine identity: 1 anomaly-flag bit + 9 machine-number bits (512 machines)
 *   8  bits — sequence, per-machine-identity counter reset each millisecond
 *
 * Encoded as 13-character Crockford Base32 — sorts lexicographically by creation
 * time since the timestamp occupies the high-order bits in cleartext, not hashed.
 *
 * Collision avoidance is deterministic by construction (different timestamps can't
 * collide; same-timestamp ids are disambiguated by machine identity, then by
 * sequence), except for local clock anomalies, handled in two layers:
 *   - Absorption: small backward jumps are absorbed by holding the emitted
 *     timestamp at a high-water-mark instead of trusting the raw clock reading.
 *   - Failover: a jump too large to absorb flips the machine field's anomaly bit,
 *     minting under a personal spare identity that can never collide with this
 *     machine's normal-identity output — no coordination with other machines needed.
 *
 * Known constraint: this generator holds its sequence/timestamp state in memory
 * per process. Two concurrent processes on the same machine sharing the same
 * configured machine number are not coordinated against each other — this assumes
 * one active generator process per machine number at a time.
 */

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const MACHINE_BITS = 10n;
const SEQUENCE_BITS = 8n;

const MACHINE_NUMBER_BITS = MACHINE_BITS - 1n; // 9 bits, 512 machines
const MAX_MACHINE_NUMBER = (1n << MACHINE_NUMBER_BITS) - 1n; // 511
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n; // 255
const ANOMALY_FLAG = 1n << MACHINE_NUMBER_BITS; // bit 9 of the machine field

const MACHINE_SHIFT = SEQUENCE_BITS;
const TIMESTAMP_SHIFT = SEQUENCE_BITS + MACHINE_BITS;

// Custom epoch: 2025-01-01T00:00:00Z. 45 bits at ms resolution gives ~1115 years
// of range from here, comfortably past any realistic project lifetime.
const EPOCH_MS = BigInt(Date.UTC(2025, 0, 1));

// A backward clock jump larger than this is treated as anomalous (NTP misconfig,
// manual clock change) rather than routine slew correction, and triggers failover
// to the spare machine identity instead of being silently absorbed.
const LARGE_JUMP_THRESHOLD_MS = 2000n;

function readMachineNumber(): bigint {
  const raw = process.env.APERAS_MACHINE_NUMBER;
  if (raw === undefined) {
    console.warn('[Aperas Snowflake] APERAS_MACHINE_NUMBER not set — defaulting to 0. ' +
      'Set a unique value (0-511) per machine to avoid id collisions across machines.');
    return 0n;
  }
  const n = BigInt(raw);
  if (n < 0n || n > MAX_MACHINE_NUMBER) {
    throw new Error(`APERAS_MACHINE_NUMBER must be between 0 and ${MAX_MACHINE_NUMBER}, got ${raw}`);
  }
  return n;
}

const machineNumber = readMachineNumber();

let anomalyMode = false;
// Once real time catches back up past this point, it's safe to return to the
// normal (non-anomaly) machine identity.
let anomalyRecoveryTimestamp = -1n;

let lastTimestamp = -1n;
let sequence = 0n;

function currentMachineField(): bigint {
  return (anomalyMode ? ANOMALY_FLAG : 0n) | machineNumber;
}

function nowRelativeToEpoch(): bigint {
  return BigInt(Date.now()) - EPOCH_MS;
}

function encodeBase32(value: bigint): string {
  let result = '';
  let v = value;
  for (let i = 0; i < 13; i++) {
    const index = Number(v & 0x1fn);
    result = CROCKFORD_ALPHABET[index] + result;
    v >>= 5n;
  }
  return result;
}

/**
 * Generates a new, stable node identity. Assigned once at creation — never
 * derived from, or invalidated by, the node's content.
 */
export function generateNodeId(): string {
  let now = nowRelativeToEpoch();

  if (anomalyMode && now >= anomalyRecoveryTimestamp) {
    anomalyMode = false;
  }

  if (now < lastTimestamp) {
    const drift = lastTimestamp - now;
    if (drift > LARGE_JUMP_THRESHOLD_MS) {
      // Large backward jump: fail over to the spare identity so ids minted during
      // the anomaly can never collide with this machine's normal-identity output,
      // past or future. Sequence restarts fresh under the new identity.
      anomalyMode = true;
      anomalyRecoveryTimestamp = lastTimestamp;
      lastTimestamp = -1n;
      now = nowRelativeToEpoch();
    } else {
      // Small jump (routine NTP correction): absorb it by holding the timestamp
      // at its last known-good value rather than trusting the raw clock reading.
      now = lastTimestamp;
    }
  }

  if (now === lastTimestamp) {
    sequence = (sequence + 1n) & MAX_SEQUENCE;
    if (sequence === 0n) {
      // Exhausted this millisecond's sequence space — spin until the next tick.
      do {
        now = nowRelativeToEpoch();
      } while (now <= lastTimestamp);
    }
  } else {
    sequence = 0n;
  }

  lastTimestamp = now;

  const id = (now << TIMESTAMP_SHIFT) | (currentMachineField() << MACHINE_SHIFT) | sequence;
  return encodeBase32(id);
}
