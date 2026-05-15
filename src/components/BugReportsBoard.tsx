import { useEffect, useMemo, useState } from 'react';

const REPO_OWNER = 'darkenedforest';
const REPO_NAME = 'tongari-boushi-to-oshare-na-mahou-tsukai-archive';
const LABEL = 'bug-report';

interface User {
  login: string;
  avatar_url: string;
  html_url: string;
}

interface Reactions {
  total_count: number;
  '+1': number;
  '-1': number;
  laugh: number;
  hooray: number;
  confused: number;
  heart: number;
  rocket: number;
  eyes: number;
}

interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  state_reason: string | null;
  user: User;
  created_at: string;
  updated_at: string;
  comments: number;
  reactions: Reactions;
  labels: { name: string; color: string }[];
  html_url: string;
}

interface Comment {
  id: number;
  user: User;
  body: string;
  created_at: string;
  reactions: Reactions;
}

type SortMode = 'open-first' | 'newest' | 'most-metoos';

const NEW_ISSUE_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/new?template=bug-report.yml`;

function issueUrl(num: number) {
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/${num}`;
}

function commentUrl(num: number) {
  return `${issueUrl(num)}#issuecomment-new`;
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Tiny markdown subset: images, links, bold, italic, code, line breaks.
// Avoids pulling a full markdown library for an MVP.
function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Patterns we look for: ![alt](url), [text](url), **bold**, *italic*, `code`
  const pattern = /(!\[([^\]]*)\]\(([^)]+)\))|(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) {
      // image — render small inline, full opens lightbox via parent
      nodes.push(
        <img
          key={`md-${key++}`}
          className="md-image"
          src={m[3]}
          alt={m[2] || ''}
          loading="lazy"
        />
      );
    } else if (m[4]) {
      nodes.push(
        <a key={`md-${key++}`} href={m[6]} target="_blank" rel="noreferrer">
          {m[5]}
        </a>
      );
    } else if (m[7]) {
      nodes.push(<strong key={`md-${key++}`}>{m[8]}</strong>);
    } else if (m[9]) {
      nodes.push(<em key={`md-${key++}`}>{m[10]}</em>);
    } else if (m[11]) {
      nodes.push(<code key={`md-${key++}`}>{m[12]}</code>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderMarkdown(body: string | null): { jsx: React.ReactNode; images: string[] } {
  if (!body) return { jsx: null, images: [] };
  // Strip GitHub's "<!-- ... -->" HTML comments
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, '').trim();
  // Pull image urls so we can render a thumbnail strip separately AND inline
  const images: string[] = [];
  const imgPattern = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = imgPattern.exec(cleaned)) !== null) {
    images.push(m[1]);
  }
  // Render paragraphs split on blank lines, with inline markdown inside
  const blocks = cleaned.split(/\n\s*\n/).map((block, i) => {
    // Split single newlines as <br>
    const lines = block.split(/\n/);
    return (
      <p key={`p-${i}`} className="md-p">
        {lines.map((line, j) => (
          <span key={`l-${i}-${j}`}>
            {renderInline(line)}
            {j < lines.length - 1 && <br />}
          </span>
        ))}
      </p>
    );
  });
  return { jsx: blocks, images };
}

function StatusPill({ issue }: { issue: Issue }) {
  const closed = issue.state === 'closed';
  const isResolved = issue.labels.some(l => l.name === 'resolved');
  const isFlagged = issue.labels.some(l => l.name === 'flagged');
  let label = 'Open';
  let cls = 'pill-open';
  if (closed && isResolved) {
    label = 'Resolved';
    cls = 'pill-resolved';
  } else if (closed) {
    label = 'Closed';
    cls = 'pill-closed';
  } else if (isFlagged) {
    label = 'Flagged';
    cls = 'pill-flagged';
  }
  return <span className={`status-pill ${cls}`}>{label}</span>;
}

function ImageThumbs({ images, onOpen }: { images: string[]; onOpen: (url: string) => void }) {
  if (!images.length) return null;
  return (
    <div className="thumb-row">
      {images.map((url, i) => (
        <button key={i} className="thumb-btn" onClick={() => onOpen(url)} aria-label="Open image">
          <img src={url} alt="" loading="lazy" />
        </button>
      ))}
    </div>
  );
}

function IssueCard({
  issue,
  onOpenImage,
}: {
  issue: Issue;
  onOpenImage: (url: string) => void;
}) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [loadingComments, setLoadingComments] = useState(false);
  const { jsx, images } = useMemo(() => renderMarkdown(issue.body), [issue.body]);
  const metoo = issue.reactions['+1'] || 0;

  useEffect(() => {
    if (issue.comments === 0) return;
    setLoadingComments(true);
    fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues/${issue.number}/comments`)
      .then(r => r.json())
      .then((data: Comment[]) => {
        setComments(Array.isArray(data) ? data : []);
        setLoadingComments(false);
      })
      .catch(() => {
        setComments([]);
        setLoadingComments(false);
      });
  }, [issue.number, issue.comments]);

  return (
    <article className="bug-card">
      <header className="bug-card-head">
        <div className="head-left">
          <span className="ticket-num">#{issue.number}</span>
          <h2 className="bug-title">{issue.title}</h2>
        </div>
        <div className="head-right">
          <StatusPill issue={issue} />
        </div>
      </header>

      <div className="bug-meta">
        <a className="author" href={issue.user.html_url} target="_blank" rel="noreferrer">
          <img src={issue.user.avatar_url} alt="" />
          <span>{issue.user.login}</span>
        </a>
        <span className="dot">·</span>
        <span className="timestamp">opened {timeAgo(issue.created_at)}</span>
      </div>

      <div className="bug-body">{jsx}</div>

      {images.length > 0 && (
        <ImageThumbs images={images} onOpen={onOpenImage} />
      )}

      <div className="bug-actions">
        <a
          className="action me-too"
          href={issueUrl(issue.number)}
          target="_blank"
          rel="noreferrer"
          title="React on GitHub to say me too"
        >
          <span className="emoji" aria-hidden>🙋</span>
          <span className="action-label">Me too</span>
          <span className="counter">{metoo}</span>
        </a>
        <a
          className="action comment"
          href={commentUrl(issue.number)}
          target="_blank"
          rel="noreferrer"
        >
          <span className="emoji" aria-hidden>💬</span>
          <span className="action-label">Add a comment</span>
          <span className="counter">{issue.comments}</span>
        </a>
        <a
          className="action gh-link"
          href={issue.html_url}
          target="_blank"
          rel="noreferrer"
        >
          View on GitHub →
        </a>
      </div>

      {issue.comments > 0 && (
        <section className="comments">
          {loadingComments && <div className="loading-comments">loading replies…</div>}
          {comments && comments.length > 0 && comments.map(c => {
            const cmd = renderMarkdown(c.body);
            return (
              <article key={c.id} className="comment">
                <header className="comment-head">
                  <a className="author small" href={c.user.html_url} target="_blank" rel="noreferrer">
                    <img src={c.user.avatar_url} alt="" />
                    <span>{c.user.login}</span>
                  </a>
                  <span className="timestamp">{timeAgo(c.created_at)}</span>
                </header>
                <div className="comment-body">{cmd.jsx}</div>
                {cmd.images.length > 0 && (
                  <ImageThumbs images={cmd.images} onOpen={onOpenImage} />
                )}
              </article>
            );
          })}
        </section>
      )}
    </article>
  );
}

export default function BugReportsBoard() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>('open-first');
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues?labels=${LABEL}&state=all&per_page=100`;
    fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`GitHub API: ${r.status}`);
        return r.json();
      })
      .then((data: Issue[]) => {
        // GH API returns PRs too in some cases — strip anything that's a PR
        setIssues(Array.isArray(data) ? data.filter(i => !(i as any).pull_request) : []);
        setLoading(false);
      })
      .catch(e => {
        setErr(String(e));
        setLoading(false);
      });
  }, []);

  const sorted = useMemo(() => {
    const list = [...issues];
    list.sort((a, b) => {
      if (sort === 'open-first') {
        if (a.state !== b.state) return a.state === 'open' ? -1 : 1;
        return (b.reactions['+1'] || 0) - (a.reactions['+1'] || 0);
      }
      if (sort === 'newest') {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      // most-metoos
      const ar = a.reactions['+1'] || 0;
      const br = b.reactions['+1'] || 0;
      if (br !== ar) return br - ar;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    return list;
  }, [issues, sort]);

  if (loading) return <div className="board-status">Loading bug reports…</div>;
  if (err) return (
    <div className="board-status error">
      Couldn't load bug reports ({err}). GitHub rate limit may be exhausted; refresh in a few minutes.
    </div>
  );

  return (
    <div className="bug-board">
      <div className="board-header">
        <a className="report-btn" href={NEW_ISSUE_URL} target="_blank" rel="noreferrer">
          <span className="emoji" aria-hidden>🐛</span>
          <span>Report a bug</span>
        </a>
        <div className="sort-pills">
          {(['open-first', 'newest', 'most-metoos'] as SortMode[]).map(s => (
            <button
              key={s}
              className={`sort-pill ${sort === s ? 'active' : ''}`}
              onClick={() => setSort(s)}
            >
              {s === 'open-first' ? 'Open first' : s === 'newest' ? 'Newest' : 'Most "me too"s'}
            </button>
          ))}
        </div>
        <span className="board-counts">
          {issues.filter(i => i.state === 'open').length} open
          <span className="dot">·</span>
          {issues.filter(i => i.state === 'closed').length} closed
        </span>
      </div>

      {sorted.length === 0 && (
        <div className="empty-state">
          <div className="empty-emoji" aria-hidden>🌸</div>
          <h3>No bug reports yet</h3>
          <p>
            Found a bug in the patch, the website, or want to suggest a feature?
            Hit the button above to open one.
          </p>
        </div>
      )}

      <div className="cards">
        {sorted.map(issue => (
          <IssueCard
            key={issue.number}
            issue={issue}
            onOpenImage={setLightbox}
          />
        ))}
      </div>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)} role="dialog">
          <button className="lightbox-close" onClick={() => setLightbox(null)} aria-label="Close">×</button>
          <img src={lightbox} alt="" />
        </div>
      )}

      <style>{`
        .board-status { padding: 60px 20px; text-align: center; color: var(--color-ink-soft); }
        .board-status.error { color: var(--color-pink-600); }

        .board-header {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 14px;
          padding: 18px 20px;
          background: linear-gradient(135deg, var(--color-pink-50), var(--color-purple-50));
          border-radius: var(--radius-lg);
          margin-bottom: 24px;
          border: 1px solid var(--color-pink-100);
        }
        .report-btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 18px;
          border-radius: var(--radius-pill);
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white;
          font-weight: 700;
          text-decoration: none;
          box-shadow: 0 6px 16px rgba(155, 123, 217, 0.35);
          transition: transform 0.12s ease;
        }
        .report-btn:hover { transform: translateY(-1px); }
        .report-btn .emoji { font-size: 1.1rem; }

        .sort-pills { display: flex; gap: 6px; flex-wrap: wrap; }
        .sort-pill {
          padding: 6px 14px;
          border-radius: var(--radius-pill);
          background: white;
          color: var(--color-purple-600);
          border: 1px solid var(--color-purple-100);
          font-weight: 600;
          font-size: 0.85rem;
          cursor: pointer;
          font-family: inherit;
        }
        .sort-pill:hover { background: var(--color-purple-100); }
        .sort-pill.active {
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white;
          border-color: transparent;
        }
        .board-counts {
          margin-left: auto;
          color: var(--color-ink-soft);
          font-size: 0.85rem;
        }
        .dot { margin: 0 6px; opacity: 0.5; }

        .empty-state {
          text-align: center;
          padding: 60px 20px;
          background: var(--surface-strong);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-soft);
          border: 1px solid var(--color-pink-100);
        }
        .empty-state .empty-emoji { font-size: 3rem; }
        .empty-state h3 { color: var(--color-pink-600); margin: 8px 0 6px; }
        .empty-state p { color: var(--color-ink-soft); max-width: 50ch; margin: 0 auto; }

        .cards {
          display: flex;
          flex-direction: column;
          gap: 18px;
        }
        .bug-card {
          background: var(--surface-strong);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-soft);
          border: 1px solid var(--color-pink-100);
          padding: 22px 24px;
          transition: box-shadow 0.15s ease, border-color 0.15s ease;
        }
        .bug-card:hover {
          box-shadow: var(--shadow-pop);
          border-color: var(--color-pink-200);
        }

        .bug-card-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 6px;
        }
        .head-left { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; flex: 1; }
        .ticket-num {
          font-family: var(--font-mono, ui-monospace, monospace);
          color: var(--color-purple-400);
          font-weight: 700;
          font-size: 0.95rem;
        }
        .bug-title {
          margin: 0;
          font-size: 1.2rem;
          color: var(--color-ink);
          font-weight: 700;
          line-height: 1.3;
        }
        .status-pill {
          display: inline-block;
          padding: 4px 12px;
          border-radius: var(--radius-pill);
          font-size: 0.78rem;
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .pill-open      { background: var(--color-pink-100);   color: var(--color-pink-600); }
        .pill-flagged   { background: #fff1c4;                  color: #b07f00; }
        .pill-resolved  { background: #d9f3df;                  color: #2c8a4a; }
        .pill-closed    { background: var(--color-purple-100); color: var(--color-purple-600); }

        .bug-meta {
          display: flex;
          align-items: center;
          gap: 6px;
          color: var(--color-ink-soft);
          font-size: 0.82rem;
          margin-bottom: 12px;
        }
        .author {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          text-decoration: none;
          color: var(--color-purple-600);
          font-weight: 600;
        }
        .author img { width: 22px; height: 22px; border-radius: 50%; }
        .author.small img { width: 18px; height: 18px; }
        .timestamp { color: var(--color-ink-soft); }

        .bug-body { color: var(--color-ink); line-height: 1.55; font-size: 0.96rem; }
        .md-p { margin: 0 0 10px; }
        .md-p:last-child { margin-bottom: 0; }
        .md-image {
          max-width: 100%;
          max-height: 220px;
          border-radius: var(--radius-md);
          margin: 6px 0;
          display: block;
        }
        .bug-body a { color: var(--color-pink-600); font-weight: 600; }
        .bug-body code {
          background: var(--color-purple-50);
          padding: 1px 6px;
          border-radius: 4px;
          font-size: 0.88em;
        }

        .thumb-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin: 10px 0;
        }
        .thumb-btn {
          padding: 0;
          border: 2px solid var(--color-pink-100);
          background: white;
          border-radius: var(--radius-md);
          overflow: hidden;
          cursor: pointer;
          transition: transform 0.12s ease, border-color 0.12s ease;
        }
        .thumb-btn:hover {
          transform: scale(1.03);
          border-color: var(--color-pink-400);
        }
        .thumb-btn img {
          display: block;
          width: 96px;
          height: 96px;
          object-fit: cover;
        }

        .bug-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 14px;
          padding-top: 14px;
          border-top: 1px dashed var(--color-pink-100);
        }
        .action {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 7px 14px;
          border-radius: var(--radius-pill);
          background: var(--color-purple-50);
          color: var(--color-purple-600);
          border: 1px solid var(--color-purple-100);
          font-weight: 600;
          font-size: 0.82rem;
          text-decoration: none;
          transition: background 0.12s ease, color 0.12s ease;
        }
        .action:hover {
          background: var(--color-purple-100);
        }
        .action.me-too:hover {
          background: var(--color-pink-100);
          color: var(--color-pink-600);
          border-color: var(--color-pink-200);
        }
        .action .counter {
          background: white;
          padding: 1px 8px;
          border-radius: 999px;
          font-size: 0.75rem;
          color: var(--color-ink);
          min-width: 16px;
          text-align: center;
        }
        .action.gh-link {
          margin-left: auto;
          background: transparent;
          border-color: transparent;
          color: var(--color-ink-soft);
        }

        .comments {
          margin-top: 14px;
          padding-top: 14px;
          border-top: 1px dashed var(--color-pink-100);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .loading-comments {
          color: var(--color-ink-soft);
          font-size: 0.85rem;
          font-style: italic;
        }
        .comment {
          background: var(--color-purple-50);
          padding: 12px 16px;
          border-radius: var(--radius-md);
          border-left: 3px solid var(--color-purple-200);
        }
        .comment-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 6px;
          font-size: 0.82rem;
        }
        .comment-body { color: var(--color-ink); font-size: 0.92rem; line-height: 1.5; }
        .comment-body .md-p { margin: 0 0 6px; }
        .comment-body .md-p:last-child { margin-bottom: 0; }

        .lightbox {
          position: fixed;
          inset: 0;
          background: rgba(74, 46, 94, 0.75);
          backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          z-index: 100;
          cursor: zoom-out;
        }
        .lightbox img {
          max-width: 96vw;
          max-height: 92vh;
          object-fit: contain;
          border-radius: var(--radius-md);
          box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        }
        .lightbox-close {
          position: absolute;
          top: 18px; right: 22px;
          width: 38px; height: 38px;
          border-radius: 50%;
          background: white;
          color: var(--color-pink-600);
          border: none;
          font-size: 1.5rem;
          cursor: pointer;
          line-height: 1;
        }
      `}</style>
    </div>
  );
}
