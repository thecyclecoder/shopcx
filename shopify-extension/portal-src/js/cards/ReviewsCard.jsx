// cards/ReviewsCard.jsx — Rotating review carousel for detail page
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { requestJson } from '../core/api.js';
import { shortId, safeStr } from '../core/utils.js';

const ROTATE_MS = 15000;
const TRUNCATE = 260;

function truncate(str, max) {
  if (!str || str.length <= max) return { text: str || '', cut: false };
  let cut = str.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return { text: cut.replace(/\s+$/, '') + '\u2026', cut: true };
}

function Stars() {
  return <div class="sp-reviews__stars" aria-label="5 out of 5 stars">{'\u2605\u2605\u2605\u2605\u2605'}</div>;
}

export default function ReviewsCard({ productIds }) {
  const [reviews, setReviews] = useState([]);
  const [idx, setIdx] = useState(0);
  const [fade, setFade] = useState('');
  const timerRef = useRef(null);

  // Fetch reviews
  useEffect(() => {
    if (!productIds?.length) return;
    const ids = productIds.map(id => shortId(id)).filter(Boolean);
    if (!ids.length) return;

    requestJson('reviews', { productIds: ids.join(',') })
      .then(resp => {
        if (!resp?.ok) return;
        const map = resp.by_product_id || {};
        const all = [];
        for (const pid of Object.keys(map)) {
          const entry = map[pid];
          if (entry?.ok && Array.isArray(entry.reviews)) {
            all.push(...entry.reviews);
          }
        }
        setReviews(all);
      })
      .catch(() => {});
  }, [productIds?.join(',')]);

  const advance = useCallback((dir) => {
    if (!reviews.length) return;
    setFade('sp-reviews__fade--out');
    setTimeout(() => {
      setIdx(prev => {
        if (dir === 'prev') return (prev - 1 + reviews.length) % reviews.length;
        return (prev + 1) % reviews.length;
      });
      setFade('sp-reviews__fade--in');
    }, 180);
  }, [reviews.length]);

  // Auto-rotate
  useEffect(() => {
    if (reviews.length <= 1) return;
    timerRef.current = setInterval(() => advance('next'), ROTATE_MS);
    return () => clearInterval(timerRef.current);
  }, [reviews.length, advance]);

  function resetTimer() {
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => advance('next'), ROTATE_MS);
  }

  if (!reviews.length) return null;

  const r = reviews[idx % reviews.length] || {};
  const title = r.summary || r.title || 'Loved it';
  const body = r.body || '';
  const { text: bodyText, cut } = truncate(body, TRUNCATE);
  const author = r.author || 'Verified Customer';

  return (
    <div class="sp-card sp-detail__card sp-reviews">
      <div class="sp-detail__sectionhead">
        <div class="sp-title2">Reviews</div>
        <p class="sp-muted sp-detail__section-sub">What customers are saying.</p>
      </div>
      <div class={'sp-reviews__inner ' + fade}>
        <Stars />
        <div class="sp-reviews__title">
          <span class="sp-reviews__quoteiconwrap" aria-hidden="true">{'\u201C'}</span>
          <span class="sp-reviews__titletext">{title}</span>
        </div>
        {bodyText && <div class="sp-reviews__body sp-muted">{'\u201C'}{bodyText}{'\u201D'}</div>}
        {cut && <a href="#" class="sp-reviews__link" onClick={(e) => e.preventDefault()}>Read full review</a>}
        <div class="sp-reviews__meta">
          <div class="sp-reviews__meta-left">
            <span class="sp-reviews__author">{author}</span>
            <span class="sp-reviews__verified">
              <span class="sp-reviews__verifiedicon" aria-hidden="true">{'\u2713'}</span>
              <span class="sp-reviews__verifiedtext">Verified</span>
            </span>
          </div>
          {reviews.length > 1 && (
            <div class="sp-reviews__nav">
              <button type="button" class="sp-reviews__navbtn sp-reviews__navbtn--prev"
                aria-label="Previous review"
                onClick={() => { advance('prev'); resetTimer(); }}>{'\u2039'}</button>
              <button type="button" class="sp-reviews__navbtn sp-reviews__navbtn--next"
                aria-label="Next review"
                onClick={() => { advance('next'); resetTimer(); }}>{'\u203A'}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
