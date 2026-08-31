import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { Icon } from '@/ui/Icon';
import { formatBytes, type ModelManifest } from '@/domain/manifest';
import { inferTemplate } from '@/ai/prompt';
import { useApp } from '@/state/app';
import { useModels } from '@/state/models';

/**
 * Hugging Face browser (PRD §3.1).
 *
 * Searches the public Hub API for GGUF repositories, lists their quantised
 * files with real sizes, and turns a chosen file into a manifest the download
 * manager can act on. Gated repositories are labelled and require a token,
 * which is stored on the device and only ever sent to huggingface.co.
 */

interface HubModel {
  id: string;
  downloads: number;
  likes: number;
  gated: boolean | string;
  tags: string[];
  pipeline_tag?: string;
}

interface HubFile {
  rfilename: string;
  size?: number;
}

interface HubDetail {
  id: string;
  gated: boolean | string;
  siblings: HubFile[];
  cardData?: { license?: string };
}

const SEARCH_URL = 'https://huggingface.co/api/models';

export function HuggingFaceBrowser({ onClose }: { onClose: () => void }): ReactNode {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<HubModel[]>([]);
  const [selected, setSelected] = useState<HubDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useApp((state) => state.settings.hfToken);

  const headers = useCallback((): Record<string, string> => {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [token]);

  const search = useCallback(
    async (term: string) => {
      setLoading(true);
      setError(null);
      try {
        const url = new URL(SEARCH_URL);
        url.searchParams.set('search', term);
        url.searchParams.set('filter', 'gguf');
        url.searchParams.set('sort', 'downloads');
        url.searchParams.set('direction', '-1');
        url.searchParams.set('limit', '25');

        const response = await fetch(url, { headers: headers() });
        if (!response.ok) throw new Error(`Hugging Face returned ${response.status}.`);
        setResults((await response.json()) as HubModel[]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Search failed.');
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [headers],
  );

  // Seed with popular GGUF repositories so the sheet is never blank.
  useEffect(() => {
    void search('instruct');
  }, [search]);

  const open = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`${SEARCH_URL}/${id}`, { headers: headers() });
        if (!response.ok) throw new Error(`Could not read ${id} (${response.status}).`);
        setSelected((await response.json()) as HubDetail);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not load that repository.');
      } finally {
        setLoading(false);
      }
    },
    [headers],
  );

  if (selected) {
    return (
      <RepoDetail
        detail={selected}
        onBack={() => setSelected(null)}
        onInstalled={onClose}
        headers={headers()}
      />
    );
  }

  return (
    <>
      <form
        className="row"
        style={{ gap: 'var(--s-2)' }}
        onSubmit={(event) => {
          event.preventDefault();
          void search(query);
        }}
      >
        <input
          className="input grow"
          placeholder="Search GGUF models"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="btn btn--primary" disabled={loading}>
          {loading ? <span className="spinner" /> : <Icon name="search" size={15} />}
        </button>
      </form>

      {!token ? (
        <p className="section__hint">
          Add a Hugging Face access token in Settings to download gated models such as Llama and
          Gemma.
        </p>
      ) : null}

      {error ? (
        <div className="card" style={{ borderLeft: '3px solid var(--crit)' }}>
          <p style={{ fontSize: 'var(--t-sm)', color: 'var(--ink-2)' }}>{error}</p>
        </div>
      ) : null}

      <div className="card card--flush">
        <div className="list">
          {results.map((model) => (
            <button
              key={model.id}
              type="button"
              className="list__item"
              data-interactive="true"
              onClick={() => void open(model.id)}
            >
              <div className="list__main">
                <span className="list__title truncate">{model.id}</span>
                <span className="list__sub">
                  {model.downloads.toLocaleString()} downloads · {model.likes} likes
                </span>
              </div>
              {model.gated ? (
                <span className="chip chip--warn">
                  <Icon name="shield" size={11} />
                  Gated
                </span>
              ) : null}
              <Icon name="chevron-right" size={16} />
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function RepoDetail({
  detail,
  onBack,
  onInstalled,
  headers,
}: {
  detail: HubDetail;
  onBack: () => void;
  onInstalled: () => void;
  headers: Record<string, string>;
}): ReactNode {
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const ggufFiles = detail.siblings.filter((file) => file.rfilename.endsWith('.gguf'));
  const mmproj = ggufFiles.find((file) => file.rfilename.toLowerCase().includes('mmproj'));
  const weights = ggufFiles.filter((file) => !file.rfilename.toLowerCase().includes('mmproj'));

  // The list endpoint omits file sizes, so ask for them with HEAD requests.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found: Record<string, number> = {};
      await Promise.all(
        weights.slice(0, 12).map(async (file) => {
          try {
            const response = await fetch(
              `https://huggingface.co/${detail.id}/resolve/main/${encodeURIComponent(file.rfilename)}`,
              { method: 'HEAD', headers },
            );
            const size = Number(
              response.headers.get('x-linked-size') ?? response.headers.get('content-length') ?? 0,
            );
            if (size > 0) found[file.rfilename] = size;
          } catch {
            // Size stays unknown; the row simply omits it.
          }
        }),
      );
      if (!cancelled) setSizes(found);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id]);

  const install = (file: HubFile): void => {
    const manifest: ModelManifest = {
      id: `hf_${detail.id}_${file.rfilename}`.replaceAll('/', '_'),
      name: `${detail.id.split('/').pop() ?? detail.id} · ${quantOf(file.rfilename)}`,
      author: detail.id.split('/')[0] ?? 'Hugging Face',
      description: `Imported from ${detail.id}.`,
      engine: 'llama-cpp',
      format: 'gguf',
      quantization: quantOf(file.rfilename) as ModelManifest['quantization'],
      capabilities: mmproj ? ['text', 'vision'] : ['text'],
      sizeBytes: sizes[file.rfilename] ?? 0,
      minRAM: Math.max(2 * 1024 ** 3, (sizes[file.rfilename] ?? 0) * 1.4),
      recommendedRAM: Math.max(4 * 1024 ** 3, (sizes[file.rfilename] ?? 0) * 2),
      recommendedBackend: 'gpu-metal',
      contextLength: 8192,
      license: detail.cardData?.license ?? 'See the model card',
      source: {
        repo: detail.id,
        file: file.rfilename,
        gated: Boolean(detail.gated),
        companions: mmproj ? [{ file: mmproj.rfilename, role: 'mmproj' as const }] : undefined,
      },
      promptTemplate: inferTemplate(detail.id),
    };

    void useModels.getState().install(manifest);
    onInstalled();
  };

  return (
    <>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
        <Icon name="chevron-left" size={14} />
        Back to results
      </button>

      <div className="stack" style={{ gap: 'var(--s-1)' }}>
        <span className="card__title">{detail.id}</span>
        {detail.gated ? (
          <span className="chip chip--warn" style={{ alignSelf: 'flex-start' }}>
            <Icon name="shield" size={11} />
            Accept the licence on Hugging Face before downloading
          </span>
        ) : null}
      </div>

      {mmproj ? (
        <p className="section__hint">
          This repository includes a vision projector, so images will work with the model.
        </p>
      ) : null}

      <div className="card card--flush">
        <div className="list">
          {weights.map((file) => (
            <button
              key={file.rfilename}
              type="button"
              className="list__item"
              data-interactive="true"
              onClick={() => install(file)}
            >
              <div className="list__main">
                <span className="list__title truncate">{file.rfilename}</span>
                <span className="list__sub">
                  {sizes[file.rfilename]
                    ? formatBytes(sizes[file.rfilename] ?? 0)
                    : 'Size unknown'}
                </span>
              </div>
              <Icon name="download" size={16} />
            </button>
          ))}
        </div>
      </div>

      {weights.length === 0 ? (
        <p className="section__hint">This repository has no GGUF files.</p>
      ) : null}
    </>
  );
}

function quantOf(filename: string): string {
  const match = /[.-](IQ\d[\w_]*|Q\d[\w_]*|F16|F32|BF16)\.gguf$/i.exec(filename);
  return match?.[1]?.toUpperCase() ?? 'mixed';
}
