// cards/ReviewsCard.jsx — Rotating review carousel, round-robin across products
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { requestJson } from '../core/api.js';
import { shortId } from '../core/utils.js';

const ROTATE_MS = 15000;
const TRUNCATE = 260;

function truncate(str, max) {
  if (!str || str.length <= max) return { text: str || '', cut: false };
  let cut = str.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return { text: cut.replace(/\s+$/, '') + '\u2026', cut: true };
}

/**
 * Build a round-robin sequence: product A review 1, product B review 1,
 * product C review 1, product A review 2, product B review 2, etc.
 */
function buildRoundRobin(byProductId) {
  const productIds = Object.keys(byProductId).filter(pid => {
    const entry = byProductId[pid];
    return entry?.ok && Array.isArray(entry.reviews) && entry.reviews.length > 0;
  });
  if (!productIds.length) return [];

  const sequence = [];
  const maxPerProduct = Math.max(...productIds.map(pid => byProductId[pid].reviews.length));

  for (let round = 0; round < maxPerProduct; round++) {
    for (const pid of productIds) {
      const reviews = byProductId[pid].reviews;
      if (round < reviews.length) {
        const r = reviews[round];
        // Only include reviews with actual content
        if (r.summary || r.title || r.body) {
          sequence.push(r);
        }
      }
    }
  }
  return sequence;
}

export default function ReviewsCard({ productIds }) {
  const [reviews, setReviews] = useState([]);
  const [idx, setIdx] = useState(0);
  const [fade, setFade] = useState('');
  const timerRef = useRef(null);

  useEffect(() => {
    if (!productIds?.length) return;
    const ids = productIds.map(id => shortId(id)).filter(Boolean);
    if (!ids.length) return;

    requestJson('reviews', { productIds: ids.join(',') })
      .then(resp => {
        if (!resp?.ok) return;
        const sequence = buildRoundRobin(resp.by_product_id || {});
        setReviews(sequence);
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

  // Headline: AI summary (always generated) → smart_quote → title → first sentence of body
  const headline = r.summary || r.title || (r.body ? r.body.split(/[.!?]/)[0] + '.' : 'Loved it');

  // Body: full review text truncated. Only show if different from headline.
  const bodyRaw = r.body || '';
  const showBody = bodyRaw && bodyRaw !== headline;
  const { text: bodyText, cut } = showBody ? truncate(bodyRaw, TRUNCATE) : { text: '', cut: false };

  const author = r.author || 'Verified Customer';

  return (
    <div class="sp-card sp-detail__card sp-reviews">
      <div class="sp-detail__sectionhead">
        <div class="sp-title2">Reviews</div>
        <p class="sp-muted sp-detail__section-sub">What customers are saying.</p>
      </div>
      <div class={'sp-reviews__inner ' + fade}>
        <div class="sp-reviews__stars" aria-label="5 out of 5 stars">
          {'\u2605\u2605\u2605\u2605\u2605'}
        </div>
        <div class="sp-reviews__title">
          <span class="sp-reviews__quoteiconwrap" aria-hidden="true">{'\u201C'}</span>
          <span class="sp-reviews__titletext">{headline}</span>
        </div>
        {showBody && bodyText && (
          <div class="sp-reviews__body sp-muted">{'\u201C'}{bodyText}{'\u201D'}</div>
        )}
        {cut && (
          <a href="#" class="sp-reviews__link" onClick={(e) => e.preventDefault()}>Read full review</a>
        )}
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
