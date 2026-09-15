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
 *
 * THE OPERATOR'S ANSWER IS CHECKED AT BOOT, BY THE STEP EVERY CODE TAKES. An
 * earlier version classified it by shape (any colon made it IPv6) and printed
 * it as what pairing would advertise, while `pairingAddressesOf` refuses the
 * commonest habit, `host:port`. The refusal would have come when a code was
 * drawn, after the confirm half had shown the value as fine, naming IPv6 for
 * text written as IPv4 with a port. So the kind is read by the typed route's
 * parser, the value goes through `pairingAddressesOf`, and a value a code cannot
 * carry refuses to start the server, saying what is wrong in the operator's
 * terms. Nothing the boot line shows is something a code would refuse.
 */

import {
  advertisedAddresses as enumerated,
  advertisedAddressesForThisMachine as enumeratedForThisMachine,
  pairingAddressesOf,
} from '@chatterang/tunnel/host';
import type { AdvertisedAddress, InterfaceMap } from '@chatterang/tunnel/host';
import {
  ADDRESS_IPV4,
  ADDRESS_IPV6,
  TypedEntryError,
  parseTypedEndpoint,
} from '@chatterang/tunnel/pairing';

export type { AdvertisedAddress, InterfaceMap } from '@chatterang/tunnel/host';

/**
 * The operator's answer if there is one, otherwise the host's enumeration of `interfaces`.
 *
 * Throws, with the reason as its `cause`, when the answer is one a pairing code
 * cannot carry.
 */
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
  const answer: AdvertisedAddress = { kind: kindOf(value), value };
  try {
    pairingAddressesOf([answer]);
  } catch (error) {
    /*
     * The parser read this text, so what the step refused is what a code has no
     * room for: the port or the brackets around an address. The kind came from
     * the parser, so the reason names the kind the operator wrote.
     */
    throw refusal(value, error, 'port');
  }
  return [answer];
}

/**
 * The kind the typed route's parser reads, not the kind the text's shape
 * suggests: `192.168.1.4:8973` is IPv4 with a port, not IPv6.
 */
function kindOf(value: string): AdvertisedAddress['kind'] {
  try {
    const { kind } = parseTypedEndpoint(value).address;
    return kind === ADDRESS_IPV4 ? 'ipv4' : kind === ADDRESS_IPV6 ? 'ipv6' : 'dns';
  } catch (error) {
    // A `.local` name parsed and was refused only because a PERSON typed it;
    // a code admits one (see `pairingAddressesOf`), so it is a DNS name here.
    if (error instanceof TypedEntryError && error.reason === 'local-name-unreachable') return 'dns';
    throw refusal(value, error, 'unparsed');
  }
}

function refusal(value: string, error: unknown, stage: 'port' | 'unparsed'): Error {
  // Anything but the parser's own refusal is not ours to explain.
  if (!(error instanceof TypedEntryError)) return error instanceof Error ? error : new Error(String(error));
  const flag = `chatterang server: --advertise ${value}`;
  if (stage === 'port') {
    return new Error(
      `${flag} carries a port or brackets, and a pairing code has nowhere to put them: it ` +
        'carries one port for all its addresses, so the server refuses the value rather than ' +
        'drop part of it. Pass the address or name alone.',
      { cause: error },
    );
  }
  if (error.reason === 'zone-index-unsupported') {
    return new Error(
      `${flag} carries a zone index, which names an interface on this machine and means nothing ` +
        'to a phone. Pass the address without it.',
      { cause: error },
    );
  }
  return new Error(
    `${flag} is not an IPv4 address, an IPv6 address or a DNS name that a pairing code can ` +
      'carry. A name is ASCII letters, digits and hyphens, between dots.',
    { cause: error },
  );
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
