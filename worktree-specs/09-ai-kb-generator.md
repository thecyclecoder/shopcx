# Worktree: AI-Generated KB Articles

## Setup
```bash
cd /Users/admin/Projects/shopcx
git worktree add ../shopcx-kb-gen feature/ai-kb-generator
cd ../shopcx-kb-gen
npm install
```

Work in `/Users/admin/Projects/shopcx-kb-gen` — NOT main.

## What to Build

On the Knowledge Base page, allow users to paste raw product intelligence (ingredients, specs, FAQs, marketing copy) and have AI write a polished KB article.

## UI Changes (`src/app/dashboard/knowledge-base/page.tsx`)

### "AI Generate" Button
Next to "New Article", add "AI Generate" button. Opens a form:

1. **Article topic** — text input: "Difference between Ashwavana Zen Relax and Guru Focus"
2. **Raw material** — large textarea: paste product specs, ingredient lists, notes, URLs, anything
3. **Target category** — dropdown (product, policy, shipping, etc.)
4. **Product mapping** — optional product dropdown
5. **Generate** button → calls API → shows preview → edit → save

### Preview + Edit
After generation:
- Show the draft in the rich text editor (same as existing article editor)
- User can edit before saving
- "Save as Draft" (published: false) or "Publish" (published: true)

## API Endpoint

### `src/app/api/workspaces/[id]/knowledge-base/generate/route.ts`

POST:
```typescript
{
  topic: string;         // What the article should be about
  raw_material: string;  // Pasted product info, notes, etc.
  category?: string;
  product_id?: string;
}
```

Implementation:
1. Call Claude Sonnet with a system prompt:
```
You are a knowledge base article writer for a health supplement and
superfood company. Write clear, helpful articles that customers can
understand. Use a warm, professional tone.

Format the article with:
- A clear title
- Short paragraphs (2-3 sentences each)
- Subheadings where appropriate (use <h2> and <h3> tags)
- No markdown — use HTML tags for formatting
- Include an excerpt (1-2 sentence summary)
```

2. User prompt:
```
Write a knowledge base article about: [topic]

Use the following raw information as source material:
[raw_material]

Return JSON:
{
  "title": "...",
  "content": "...(plain text)...",
  "content_html": "...(HTML formatted)...",
  "excerpt": "...(1-2 sentence summary)...",
  "slug": "...(url-friendly-slug)..."
}
```

3. Parse JSON response
4. Return the generated article fields
5. Do NOT save automatically — return to frontend for review

## Files to Create
- `src/app/api/workspaces/[id]/knowledge-base/generate/route.ts`
- Modify `src/app/dashboard/knowledge-base/page.tsx` — add generate button + form

## Integration with KB Gap Notifications
When a knowledge_gap notification exists, the "AI Generate" form could pre-fill the topic from the gap query. Add a "Generate Article" link on knowledge_gap notifications.

## Testing
1. Paste product ingredients for Ashwavana → generate article about "Is Ashwavana safe during pregnancy?"
2. Paste comparison data → generate "Zen Relax vs Guru Focus" article
3. Verify HTML formatting is clean
4. Verify article saves correctly with slug + embedding generation

## When Done
Push to `feature/ai-kb-generator` branch. Tell the merge manager (main terminal) to merge.
