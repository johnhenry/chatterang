/**
 * `MountHost` — reading a folder the user granted, and nothing else (#246).
 *
 * `src/shell/mount.ts` projects a granted directory into the shell at
 * `/mnt/<name>`. It cannot open a file itself: `src/` may not name a Node
 * builtin, and the browser has no real filesystem at all. This is the contract
 * it reaches a real one through.
 *
 * ## Why granting is a method rather than an argument
 *
 * The obvious shape is `mount(path)`, and it is the wrong one. The caller is a
 * web page driving a shell that a MODEL can drive, so a root the caller names
 * is a root a prompt injection names — `mount('/')` costs nothing to ask for
 * and the page has no way to prove a human meant it.
 *
 * So the root is never an argument. {@link MountHostPlugin.pick} opens the
 * operating system's own folder chooser and answers with what the person
 * selected; every other method takes a path and is refused unless it resolves
 * inside something `pick` returned. A grant is therefore a CONSENT EVENT with
 * a timestamp and a human behind it, not a capability the page holds.
 *
 * That is also why `writable` on the returned grant is the host's answer and
 * not the caller's request. The caller may ask; the host decides, and a host
 * that only ever grants reads is a conforming implementation.
 *
 * ## Paths are real and absolute, and that is deliberate
 *
 * Every method here takes an absolute host path — the same shape `pick`
 * returned as `root` — rather than a mount-relative one. The alternative
 * (`{ id, relative }`) looks safer and is not: it moves the join into the
 * implementation, which then has to re-derive what the caller meant, and it
 * hides the one string a reviewer needs to see. Confinement does not come from
 * the path's shape; it comes from resolving it and checking where it landed.
 * See {@link MountHostPlugin.realpath}.
 *
 * ## Not persisted
 *
 * Nothing here says a grant outlives the process, and no implementation should
 * make it. A grant that survives a restart is an ambient capability wearing a
 * consent event's clothes: the person who clicked "Open" last Tuesday is not
 * present to be asked again, and the folder they picked may now contain
 * something they would not have picked. Re-picking is cheap. Re-granting by
 * accident is not.
 */

/** One folder a person chose, as the host reports it back. */
export interface MountGrantInfo {
  /** Opaque, host-assigned. The caller never invents one. */
  readonly id: string;
  /** A short name for the mount point. Derived from the folder, deduplicated. */
  readonly name: string;
  /** The resolved absolute directory. Symlinks already followed. */
  readonly root: string;
  /**
   * May the shell write here?
   *
   * The HOST's answer. A caller that asked for write and reads `false` was
   * refused, and must treat the grant as read-only rather than retrying.
   */
  readonly writable: boolean;
  /** When the person granted it. Milliseconds since the epoch. */
  readonly grantedAt: number;
}

export interface MountStatInfo {
  readonly isDirectory: boolean;
  /**
   * Only ever true from {@link MountHostPlugin.lstat}. `stat` follows links
   * and answers about the target, which is what a caller asking `stat` means.
   */
  readonly isSymbolicLink: boolean;
  readonly size: number;
  /** Modification time, milliseconds since the epoch. */
  readonly mtimeMs: number;
  /** POSIX mode bits. A consumer that needs a number must not be handed a guess. */
  readonly mode: number;
}

export interface MountHostPlugin {
  /**
   * Ask the person to choose a folder.
   *
   * Resolves to `null` when they cancel — a refusal, not an error, because a
   * cancelled picker is the ordinary outcome and an exception would make the
   * caller treat "no thanks" as a fault.
   *
   * MUST be driven by the operating system's own chooser. An implementation
   * that answers from a configured path has removed the only thing that makes
   * every other method on this interface safe.
   */
  pick(options?: { readonly writable?: boolean }): Promise<MountGrantInfo | null>;

  /** Every grant still in force. */
  list(): Promise<{ readonly grants: readonly MountGrantInfo[] }>;

  /**
   * Withdraw one grant.
   *
   * `revoked` is false when the id was not held — already revoked, or never
   * granted. Both are the same answer to the only question the caller has.
   */
  revoke(options: { readonly id: string }): Promise<{ readonly revoked: boolean }>;

  /**
   * Canonicalise a path: symlinks and `..` resolved, refused if it lands
   * outside every grant.
   *
   * THE CONTAINMENT CHECK HAS NO OTHER SOURCE OF TRUTH, which makes this the
   * one method it is fatal to approximate. Returning the argument unchanged —
   * the tempting shim on a platform where canonicalisation is awkward — turns
   * every guarantee above into a string comparison against a lie.
   *
   * Resolves a path whose LEAF does not exist yet, by resolving the deepest
   * ancestor that does and re-attaching the rest. A caller creating a file
   * needs to ask about it before it is there, and a symlinked PARENT pointing
   * out of the grant must be caught in exactly that case.
   */
  realpath(options: { readonly path: string }): Promise<{ readonly path: string }>;

  /** Read a file as UTF-8. */
  readFile(options: { readonly path: string }): Promise<{ readonly data: string }>;

  /** Write a file as UTF-8. Refused unless the containing grant is writable. */
  writeFile(options: { readonly path: string; readonly data: string }): Promise<void>;

  /** Entry names in a directory. Not recursive, and not sorted by contract. */
  readdir(options: { readonly path: string }): Promise<{ readonly entries: readonly string[] }>;

  stat(options: { readonly path: string }): Promise<MountStatInfo>;

  /**
   * Stat WITHOUT following a final symlink.
   *
   * The method that lets a caller tell "this is not there" from "this is a
   * symlink whose target is not there". Those are the same `ENOENT` from
   * `realpath`, and treating the second as the first is an arbitrary-create
   * primitive outside the grant — see `src/shell/mount.ts:realPathWithin`,
   * which exists to make that distinction and cannot without this.
   */
  lstat(options: { readonly path: string }): Promise<MountStatInfo>;

  /** Refused unless the containing grant is writable. */
  mkdir(options: { readonly path: string; readonly recursive?: boolean }): Promise<void>;

  /** Refused unless the containing grant is writable. */
  rm(options: { readonly path: string; readonly recursive?: boolean }): Promise<void>;
}
