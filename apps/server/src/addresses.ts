/**
 * WHAT A HEADLESS SERVER ADVERTISES: ITS OPERATOR'S ANSWER, OR THE HOST'S
 * GUESS (#252).
 *
 * The guess — which of this machine's addresses a phone could dial, best
 * first — is not made here. It is `advertisedAddresses` in
 * `@chatterang/tunnel/host` (`packages/tunnel/src/host/addresses.ts`), whose
 * header records why a host is allowed to guess at all. It moved there because
 * the desktop's pairing payload needs the same list, and the desktop cannot
 * import this app, which depends on it. #158 asks for one implementation.
 *
 * What stays is what only a server has:
 *
 *   - `--advertise`, the operator's answer. When it is given it is the ONLY
 *     answer, never joined to the guess. **`--advertise` as a REQUIREMENT**
 *     was rejected because it fails silently: an operator who gets it wrong
 *     ships a code whose addresses nothing answers, and the phone's symptom is
 *     a connection that never completes. Enumeration is wrong loudly and in
 *     public, where the printed list can be read and corrected.
 *   - the line printed at boot, {@link describeAdvertised}: the CONFIRM half of
 *     enumerate-and-confirm.
 */

import {
  advertisedAddresses as enumerated,
  advertisedAddressesForThisMachine as enumeratedForThisMachine,
} from '@chatterang/tunnel/host';
import type { AdvertisedAddress, InterfaceMap } from '@chatterang/tunnel/host';

export type { AdvertisedAddress, InterfaceMap } from '@chatterang/tunnel/host';

/** The operator's answer if there is one, otherwise the host's enumeration of `interfaces`. */
export function advertisedAddresses(
  interfaces: InterfaceMap,
  override?: string | undefined,
): readonly AdvertisedAddress[] {
  return operatorsAnswer(override) ?? enumerated(interfaces);
}

/** The same, against the interfaces this machine really has. */
export function advertisedAddressesForThisMachine(
  override?: string | undefined,
): readonly AdvertisedAddress[] {
  return operatorsAnswer(override) ?? enumeratedForThisMachine();
}

function operatorsAnswer(override: string | undefined): readonly AdvertisedAddress[] | undefined {
  if (override === undefined || override.trim() === '') return undefined;
  /*
   * THE OPERATOR'S ANSWER REPLACES OURS, rather than joining it. A list that
   * appended the guess to the override would re-leak exactly what an operator
   * setting this flag is usually trying not to publish, and would do it
   * invisibly because the flag appeared to be honoured.
   */
  const value = override.trim();
  return [{ kind: kindOf(value), value }];
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
 *
 * IT SAYS "WILL", because pairing is not on: this server starts no tunnel
 * listener and mints no pairing code (`tunnel-identity.ts`: nothing calls its
 * key loader yet). And IT NAMES NO CERTIFICATE, because none carries this
 * list: #295's ruling has a client check only the key pin it learned at
 * pairing, never a certificate's hostname or SAN list. The change that turns
 * pairing on moves these lines with it.
 */
export function describeAdvertised(
  addresses: readonly AdvertisedAddress[],
  overridden: boolean,
): readonly string[] {
  if (addresses.length === 0) {
    return [
      'pairing is not on yet, and no reachable address was found on this machine: once it is on, ' +
        'a phone cannot be told where to connect, so pairing codes will not work. Pass ' +
        '--advertise <host> with a name or address this machine answers on.',
    ];
  }
  const list = addresses.map((a) => a.value).join(', ');
  if (overridden) return [`pairing is not on yet. Once it is, it will advertise (--advertise): ${list}`];
  return [
    `pairing is not on yet. Once it is, it will advertise, best first: ${list}`,
    'if a phone cannot reach any of these, pass --advertise <host> with the name you reach this ' +
      'machine by.',
  ];
}
