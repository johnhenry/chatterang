/**
 * WHERE THIS SERVER MAY LISTEN, AS A TYPE.
 *
 * The milestone's requirement is not "check for a token before binding to
 * 0.0.0.0". It is that *binding beyond loopback without auth cannot be
 * expressed* — because a check is a thing an operator can forget, disable, or
 * lose in a refactor, and a shape is not.
 *
 * So the bind address and the credentials are ONE VALUE, not two flags that
 * can disagree:
 *
 *   { kind: 'loopback',      port, token }                — no host field AT ALL
 *   { kind: 'authenticated', host, port, token, tls }     — both required
 *
 * The loopback arm has nowhere to put a host: `listenHost()` returns the
 * literal `127.0.0.1` for it, and there is no field an operator could set to
 * change that. The authenticated arm cannot be written down without an
 * {@link AuthToken} and {@link TlsMaterial}, and neither of those can be
 * written down at all — both are branded with a symbol this module does not
 * export, so the only way to obtain one is to call the function that produces
 * it from real bytes on a real disk. `{ kind: 'authenticated', host: '0.0.0.0',
 * port: 8080, token: 'hunter2', tls: {} }` is not a value TypeScript will
 * accept, and `tests/server-binding.test.ts` pins that with `@ts-expect-error`
 * — which `npm run typecheck` verifies is still an error, so the day the union
 * is loosened the BUILD fails rather than the deployment.
 *
 * WHY TLS IS REQUIRED IN THE SECOND ARM AND NOT MERELY RECOMMENDED. A bearer
 * token over plaintext LAN http is a bearer token on the wire: anything that
 * can read one request can replay every later one. A server that asks for a
 * credential and then publishes it is worse than one that asks for nothing,
 * because it reads as protected. If an operator does not have a certificate,
 * the honest answer is the loopback arm plus an SSH tunnel — which is a real
 * answer, not a consolation.
 *
 * WHY REFUSING IS THE WHOLE POLICY. This repo already refuses twice rather than
 * guessing — `host/entry.ts` will not start without a model root ("quietly
 * picking a directory would be a confinement to the wrong place — which reads
 * as a working guard and is not one"), and `shell/index.ts` will not start on a
 * module that can address a real filesystem. `--host 0.0.0.0` with no
 * certificate is the same class of thing, and gets the same answer: a boot
 * failure naming what is missing.
 *
 * ── WHY THE LOOPBACK ARM CARRIES A TOKEN TOO, WHICH IT DID NOT ──────────
 *
 * It shipped without one. The reasoning was that `127.0.0.1` is unreachable
 * from another machine, and that the two gates in `http.ts` — a same-origin
 * check and a custom request header that forces a CORS preflight — keep the
 * one caller that CAN reach it, a web page in the operator's own browser, from
 * doing anything with it. Both halves of that are still true and neither was
 * the whole question.
 *
 * MEASURED, on 127.0.0.1 with no token, in two requests:
 *
 *   Filesystem.writeFile  -> {"ok":true,…}   arbitrary bytes inside the data root
 *   Filesystem.rmdir      -> {"ok":true}     the model directory, recursively, gone
 *
 * Neither request was a browser. `curl` sends no `Origin`, and `originAllowed`
 * accepts an absent one — it must, because browsers omit it on same-origin
 * GETs. `curl` also sets any header it likes, so the preflight that stops a
 * cross-origin `fetch` never happens to it, and the session id it needs is
 * handed out by an event stream that was equally open. Every gate held exactly
 * as designed and the gates were aimed at the wrong principal.
 *
 * THE PRINCIPAL IS THE POINT. "Only this machine can reach it" is a statement
 * about machines, and the thing being protected is not a machine — it is the
 * operator's model directory, their GPU, and the disk under both. A cron job,
 * a dependency's postinstall script, a second person on a shared box, anything
 * the operator did not start: all of them are on this machine and none of them
 * is the operator. Deleting the model directory is not a read, and there is no
 * version of "safe because it is local" that survives a stranger's process
 * calling `rmdir({recursive:true})` and being answered `{"ok":true}`.
 *
 * So there is one rule on both arms — every binding carries a token, and
 * `http.ts` gate 1 checks it on every route — rather than a rule with an
 * exception for the arm that happens to be the default. The exception is what
 * was mutated away without anything noticing; a single unconditional check has
 * nothing to remove that a test cannot see.
 *
 * WHAT IT COSTS THE OPERATOR: one visit to the `?token=…` URL printed at
 * startup, which sets an HttpOnly cookie and is then never needed again. The
 * page's own `fetch` and `EventSource` are same-origin and carry it with no
 * client change at all. That is the whole cost, and it is smaller than the
 * paragraph explaining why it was not paid.
 *
 * WHAT IT DOES NOT BUY, said plainly: a process on this machine that can READ
 * `<root>/server-token` is the operator as far as this server is concerned.
 * The file is 0600 and that is the boundary — the same boundary an SSH key
 * has. What changes is that reaching the bridge now requires having read
 * something, rather than requiring nothing.
 */

/**
 * The loopback address, as a literal that appears exactly once.
 *
 * `localhost` would be wrong: it resolves through the host's name service and
 * can answer `::1`, a LAN address, or whatever a hosts file says. The point of
 * this arm is an address no other machine can route to, so it is the address
 * rather than a name for it.
 */
export const LOOPBACK_HOST = '127.0.0.1';

declare const TOKEN_BRAND: unique symbol;
declare const TLS_BRAND: unique symbol;

/**
 * A pre-shared operator token.
 *
 * ONE SECRET, NOT AN ACCOUNT SYSTEM. This is one person reaching their own
 * machine; inventing users, password hashing and a session store would create
 * exactly the multi-tenancy this milestone cannot honestly deliver (see
 * `apps/server/src/index.ts` on what the server does and does not own).
 *
 * The brand is not decoration: it is what stops a string literal, an
 * environment variable read, or an empty default from ever being one.
 */
export interface AuthToken {
  readonly [TOKEN_BRAND]: true;
  /** The secret itself. Never logged, never sent in a response body. */
  readonly value: string;
}

/** A key and certificate, read from disk and non-empty. */
export interface TlsMaterial {
  readonly [TLS_BRAND]: true;
  readonly key: string;
  readonly cert: string;
}

/**
 * Wrap a secret as an {@link AuthToken}.
 *
 * Not exported from the package's public surface on purpose — `token.ts` is
 * the only intended caller, because it is the only place that generates or
 * reads the secret. Refuses anything short enough to be guessed, so a typo'd
 * environment variable cannot become a credential.
 */
export function asAuthToken(value: string): AuthToken {
  if (value.length < 32) {
    throw new Error(
      `chatterang server: a token of ${value.length} characters is not a credential. ` +
        'Tokens are generated by the server; delete the token file to have a new one made.',
    );
  }
  return { value } as AuthToken;
}

/**
 * Wrap key/cert bytes as {@link TlsMaterial}.
 *
 * Both must be non-empty. An empty file is the shape a half-finished
 * certificate setup takes, and a server that started with one would be
 * advertising https while failing every handshake — which an operator reads as
 * "the network is broken", not as "there is no certificate".
 */
export function asTlsMaterial(key: string, cert: string): TlsMaterial {
  if (key.trim() === '' || cert.trim() === '') {
    throw new Error(
      'chatterang server: the TLS key and certificate must both be non-empty. ' +
        'Binding beyond loopback requires real material, not a placeholder.',
    );
  }
  return { key, cert } as TlsMaterial;
}

/**
 * Where the server may listen. See the file header: this union IS the policy.
 */
export type ServerBinding =
  | {
      readonly kind: 'loopback';
      readonly port: number;
      /**
       * Required, exactly as on the other arm. See the file header: an
       * unauthenticated bridge on 127.0.0.1 answered a stranger's process
       * `{"ok":true}` to a recursive delete of the model directory.
       */
      readonly token: AuthToken;
    }
  | {
      readonly kind: 'authenticated';
      /** Any address, INCLUDING a loopback one — auth is never wrong to have. */
      readonly host: string;
      readonly port: number;
      readonly token: AuthToken;
      readonly tls: TlsMaterial;
    };

/**
 * The address to bind.
 *
 * The loopback arm answers a constant. There is deliberately no path through
 * this function by which a `loopback` binding reaches any other address —
 * that is the whole difference between this design and a validated `--host`
 * flag.
 */
export function listenHost(binding: ServerBinding): string {
  return binding.kind === 'loopback' ? LOOPBACK_HOST : binding.host;
}

/**
 * Does the cookie this binding sets get the `Secure` attribute?
 *
 * NOT UNCONDITIONAL ANY MORE, and the change is forced rather than chosen. A
 * `Secure` cookie is one a browser will only send back over https; setting it
 * on the plaintext loopback arm would produce a `Set-Cookie` the browser
 * accepts (127.0.0.1 is a potentially-trustworthy origin, so Chrome and
 * Firefox allow it) and Safari historically does not — an authentication that
 * works in three browsers and silently loops in the fourth. There is no wire
 * to sniff on loopback and no https origin to downgrade from, so the attribute
 * buys nothing there; `HttpOnly` and `SameSite=Strict`, which are what stop a
 * script and a cross-site navigation, are set on both arms unconditionally.
 */
export function cookieIsSecure(binding: ServerBinding): boolean {
  return binding.kind === 'authenticated';
}

/** `http` or `https`. TLS is present exactly when the second arm is. */
export function scheme(binding: ServerBinding): 'http' | 'https' {
  return binding.kind === 'loopback' ? 'http' : 'https';
}

/**
 * The origin a page served by this binding will report.
 *
 * Used for the same-origin check on the API routes, so it has to be spelled
 * the way a browser spells it: no port for the default port of the scheme.
 */
export function selfOrigin(binding: ServerBinding, host = listenHost(binding)): string {
  const protocol = scheme(binding);
  const defaultPort = protocol === 'https' ? 443 : 80;
  return binding.port === defaultPort
    ? `${protocol}://${host}`
    : `${protocol}://${host}:${binding.port}`;
}

/* ── The command line, and the refusal that is the point of it ────────── */

/** What the operator asked for, before it is known to be expressible. */
export interface BindingRequest {
  readonly host?: string;
  readonly port?: number;
  readonly tlsKeyPath?: string;
  readonly tlsCertPath?: string;
}

/** Everything a non-loopback binding needs, supplied by the caller. */
export interface Credentials {
  /** Reads and validates the material named by the two paths. */
  readonly tls: (keyPath: string, certPath: string) => TlsMaterial;
  /** The persisted operator token, created on first use. */
  readonly token: () => AuthToken;
}

/** Default port. 8973 spells nothing; it is simply unlikely to be taken. */
export const DEFAULT_PORT = 8973;

/**
 * Turn a request into a binding, or refuse.
 *
 * THE REFUSAL IS THE FEATURE. Three of the four combinations of (host beyond
 * loopback) x (TLS material) are refused here, and the fourth is the only one
 * the type system would have accepted anyway — this function cannot invent a
 * binding the union does not admit, which is why the guarantee survives
 * someone rewriting this parser.
 *
 * @throws Error naming exactly what is missing.
 */
export function resolveBinding(request: BindingRequest, credentials: Credentials): ServerBinding {
  const port = request.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`chatterang server: ${String(request.port)} is not a port.`);
  }

  const host = request.host;
  const hasTls = request.tlsKeyPath !== undefined || request.tlsCertPath !== undefined;

  if (host === undefined || host === LOOPBACK_HOST) {
    // The token is read (or created) for the loopback arm too. See the file
    // header: the arm that binds nowhere is still the arm that answers the
    // plugin bridge, and every process on this machine can reach it.
    if (!hasTls) return { kind: 'loopback', port, token: credentials.token() };
    // TLS on loopback is not a mistake, and refusing it would be. It is the
    // authenticated arm with a loopback address: a token is still required,
    // because the whole point of the second arm is that it never binds without
    // one.
    return authenticated(host ?? LOOPBACK_HOST, port, request, credentials);
  }

  if (!hasTls) {
    throw new Error(
      `chatterang server: refusing to bind ${host}:${port}. Anything past loopback is reachable ` +
        'by another machine, so it requires a certificate (--tls-key and --tls-cert) and the ' +
        'operator token this server generates. A bearer token over plaintext http is a bearer ' +
        'token on the wire. Bind 127.0.0.1 and tunnel to it if you have no certificate.',
    );
  }
  return authenticated(host, port, request, credentials);
}

function authenticated(
  host: string,
  port: number,
  request: BindingRequest,
  credentials: Credentials,
): ServerBinding {
  const { tlsKeyPath, tlsCertPath } = request;
  if (tlsKeyPath === undefined || tlsCertPath === undefined) {
    throw new Error(
      'chatterang server: --tls-key and --tls-cert go together. Half a certificate is not ' +
        'a certificate, and a server that started with one would advertise https and fail ' +
        'every handshake.',
    );
  }
  return {
    kind: 'authenticated',
    host,
    port,
    tls: credentials.tls(tlsKeyPath, tlsCertPath),
    token: credentials.token(),
  };
}

/**
 * Read the flags this server understands, and refuse the ones it does not.
 *
 * An unknown flag is an error rather than a shrug: `--no-auth`, `--insecure`
 * and `--allow-remote` are exactly the flags someone will try, and silently
 * ignoring one would leave them believing it did something.
 */
export function parseArgv(argv: readonly string[]): BindingRequest & {
  readonly root?: string;
  readonly bundle?: string;
  readonly hosts?: string;
  /**
   * What pairing advertises, overriding what this machine can see (#252).
   *
   * Separate from `--host`, which is a BIND address, and the distinction is
   * the whole reason this flag exists: `0.0.0.0` is a legitimate thing to bind
   * and never a thing to dial. See `addresses.ts`.
   */
  readonly advertise?: string;
} {
  const out: {
    host?: string;
    port?: number;
    tlsKeyPath?: string;
    tlsCertPath?: string;
    root?: string;
    bundle?: string;
    hosts?: string;
    advertise?: string;
  } = {};
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    const value = argv[at + 1];
    const need = (): string => {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`chatterang server: ${String(flag)} needs a value.`);
      }
      at += 1;
      return value;
    };
    switch (flag) {
      case '--host':
        out.host = need();
        break;
      case '--advertise':
        out.advertise = need();
        break;
      case '--port':
        out.port = Number(need());
        break;
      case '--tls-key':
        out.tlsKeyPath = need();
        break;
      case '--tls-cert':
        out.tlsCertPath = need();
        break;
      case '--root':
        out.root = need();
        break;
      case '--bundle':
        out.bundle = need();
        break;
      case '--hosts':
        out.hosts = need();
        break;
      default:
        throw new Error(
          `chatterang server: unknown option ${String(flag)}. This server takes --root, ` +
            '--bundle, --hosts, --port, --host, --tls-key and --tls-cert. There is no flag ' +
            'that turns authentication off; the binding that would need one cannot be ' +
            'constructed.',
        );
    }
  }
  return out;
}
