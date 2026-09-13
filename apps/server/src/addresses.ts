/**
 * WHAT A HEADLESS SERVER ADVERTISES, AND WHY IT IS ALLOWED TO GUESS (#252).
 *
 * `main.ts` refuses to turn a wildcard bind into a browsable URL, and is right
 * to: "`0.0.0.0` and `::` are bind addresses, not places to browse to … Only
 * they know which of this machine's names they reach it by." That is the
 * correct answer for a line an operator pastes, and it is NOT sufficient for
 * pairing, where the phone needs somewhere to dial and there is no operator in
 * the loop at that moment.
 *
 * So this file guesses — and the reasoning above is SUPERSEDED HERE RATHER
 * THAN CONTRADICTED, which #252 asks for explicitly. Two things make that
 * legitimate:
 *
 *   1. It offers SEVERAL addresses, not one. #134's payload already ruled this
 *      way and said why: "offering one and being wrong costs a failed pairing,
 *      while offering several costs a network-topology leak to whoever
 *      photographs a code that expires in ninety seconds. The second is
 *      smaller." A guess that admits it is a guess is not the thing `main.ts`
 *      refuses to do.
 *   2. The operator can override it (`--advertise`), and when they do, theirs
 *      is the ONLY answer. That is the same shape `main.ts` already uses:
 *      print the honest thing, let the operator supply what only they know.
 *
 * #252 calls this enumerate-and-confirm and it is what this implements. The
 * rejected option, stated with its cost as #181's ruling states its own:
 * **`--advertise` as a REQUIREMENT** was rejected because it fails silently —
 * an operator who gets it wrong ships a code whose addresses nothing answers,
 * and the phone's symptom is a connection that never completes. Enumeration is
 * wrong loudly and in public, where the printed list can be read and
 * corrected, and a mistake costs one of several addresses rather than all of
 * them.
 *
 * ONE SOURCE, TWO CONSUMERS. #179's certificate SANs must cover every name the
 * phone might dial — #181 made the certificate a pin, so a SAN list that
 * disagrees with the advertised list fails the pin, and the failure mode is a
 * connection that does not complete rather than an error naming the cause.
 * Both lists come from {@link advertisedAddresses} for that reason.
 */

import { networkInterfaces } from 'node:os';

/** One place the phone could dial. Strings here; #134 encodes them to bytes. */
export interface AdvertisedAddress {
  readonly kind: 'ipv4' | 'ipv6' | 'dns';
  readonly value: string;
}

/**
 * The shape of `os.networkInterfaces()`, restated so this file can be tested
 * with an injected map rather than with whatever the build machine has.
 *
 * A function that reads the real interfaces is untestable in the way that
 * matters: the interesting cases are the ones this machine does not have.
 */
export interface InterfaceAddress {
  readonly address: string;
  readonly family: string | number;
  readonly internal: boolean;
}
export type InterfaceMap = Readonly<Record<string, readonly InterfaceAddress[] | undefined>>;

/** #134's cap. Offering more than this cannot be encoded anyway. */
export const MAX_ADVERTISED = 8;

const isFour = (a: InterfaceAddress): boolean => a.family === 'IPv4' || a.family === 4;

/**
 * The /64 an IPv6 address sits in — its first four groups, expanded.
 *
 * Two addresses sharing one are two names for the same position on the same
 * network, which is what makes keeping only the first of them lossless.
 */
function sixtyFour(address: string): string {
  const [head = '', tail = ''] = address.toLowerCase().split('::');
  const left = head.split(':').filter((g) => g !== '');
  const right = tail.split(':').filter((g) => g !== '');
  const fill = address.includes('::') ? Array(8 - left.length - right.length).fill('0') : [];
  return [...left, ...fill, ...right].slice(0, 4).map((g) => g.padStart(4, '0')).join(':');
}

/**
 * Rank, lowest first. The phone tries them in order, so this is a claim about
 * which address is most likely to be reachable by a phone on the same network
 * as the server — NOT about which is most correct.
 */
function rank(address: string, four: boolean): number {
  if (four) {
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) return 0; // private LAN
    return 2; // globally routable
  }
  if (/^f[cd]/i.test(address)) return 1; // unique-local
  return 3; // global IPv6
}

/**
 * Addresses this machine believes a phone could reach it at, best first.
 *
 * Excluded, each for a reason a phone would otherwise pay for:
 *
 *   - **loopback** (`internal`), because the phone is by definition not this
 *     machine. A loopback address in a pairing code is a guaranteed failure.
 *   - **IPv4 link-local** (169.254/16), which means DHCP failed. It is an
 *     address the machine invented for itself, not one anybody routes to.
 *   - **IPv6 link-local** (fe80::/10), because it is unusable without a zone
 *     index, and a zone index is local to the host that wrote it — so the
 *     phone cannot act on the one we would send.
 *
 * Everything left is offered. That includes globally routable addresses, which
 * is the topology leak #252 names: a photographed code names this machine on
 * the public internet for ninety seconds. `--advertise` is how an operator who
 * minds says so, and the printed list is how they find out they mind.
 */
export function advertisedAddresses(
  interfaces: InterfaceMap,
  override?: string | undefined,
): readonly AdvertisedAddress[] {
  if (override !== undefined && override.trim() !== '') {
    /*
     * THE OPERATOR'S ANSWER REPLACES OURS, rather than joining it. A list that
     * appended the guess to the override would re-leak exactly what an
     * operator setting this flag is usually trying not to publish, and would
     * do it invisibly because the flag appeared to be honoured.
     */
    const value = override.trim();
    return [{ kind: kindOf(value), value }];
  }

  const found: { address: AdvertisedAddress; rank: number }[] = [];
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.internal) continue;
      const four = isFour(entry);
      const address = four ? entry.address : entry.address.replace(/%.*$/, '');
      if (four && /^169\.254\./.test(address)) continue;
      if (!four && /^fe[89ab]/i.test(address)) continue;
      if (found.some((f) => f.address.value === address)) continue;
      /*
       * ONE ADDRESS PER IPv6 /64, AND THIS WAS FOUND BY RUNNING IT.
       *
       * The unit tests could not see it because they supply the interfaces.
       * On a real machine, IPv6 privacy extensions hand out several TEMPORARY
       * addresses in the same /64 — this one produced four — and they reach
       * exactly the same network by exactly the same route. Advertising all of
       * them consumed half of #134's eight-address budget, crowding out
       * genuinely different routes, and multiplied the topology leak #252
       * names without buying one extra chance of connecting.
       *
       * v4 is not deduplicated this way: two v4 addresses on one machine are
       * normally two different networks, which is the case worth carrying.
       *
       * The `!four` guard is INTENT, not behaviour, and mutation testing says
       * so: removing it changes nothing, because `sixtyFour` of a v4 address
       * is the whole address, so the check can only ever fire where the exact
       * match above already did. Kept because a reader deciding whether v4 is
       * collapsed should not have to work that out, and recorded here so the
       * surviving mutant is a known fact rather than a missing test.
       */
      if (!four && found.some((f) => f.address.kind === 'ipv6' && sixtyFour(f.address.value) === sixtyFour(address))) {
        continue;
      }
      found.push({ address: { kind: four ? 'ipv4' : 'ipv6', value: address }, rank: rank(address, four) });
    }
  }
  return found
    .sort((a, b) => a.rank - b.rank || a.address.value.localeCompare(b.address.value))
    .slice(0, MAX_ADVERTISED)
    .map((f) => f.address);
}

/** Reads the real interfaces. Separated so the logic above stays testable. */
export function advertisedAddressesForThisMachine(
  override?: string | undefined,
): readonly AdvertisedAddress[] {
  return advertisedAddresses(networkInterfaces() as InterfaceMap, override);
}

function kindOf(value: string): AdvertisedAddress['kind'] {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return 'ipv4';
  if (value.includes(':')) return 'ipv6';
  return 'dns';
}

/**
 * What the operator is shown, so they can confirm or override it.
 *
 * The CONFIRM half of enumerate-and-confirm, and it is not decoration: an
 * operator who never sees the list cannot know it is wrong, and #252's whole
 * objection to a silent `--advertise` is that a wrong value fails invisibly.
 * Printing is how enumeration avoids the same charge.
 */
export function describeAdvertised(
  addresses: readonly AdvertisedAddress[],
  overridden: boolean,
): readonly string[] {
  if (addresses.length === 0) {
    return [
      'pairing: no reachable address found on this machine. A phone cannot be told where to ' +
        'connect, so pairing codes will not work. Pass --advertise <host> with a name or address ' +
        'this machine answers on.',
    ];
  }
  const how = overridden
    ? 'pairing advertises (--advertise): '
    : 'pairing advertises, best first: ';
  return [
    how + addresses.map((a) => a.value).join(', '),
    overridden
      ? ''
      : 'if a phone cannot reach any of these, pass --advertise <host> with the name you reach ' +
        'this machine by. These addresses go into every pairing code and into the certificate.',
  ].filter((line) => line !== '');
}
