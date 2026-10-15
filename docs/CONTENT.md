# Content: stories and vocabulary

## Starter stories

`src/content/starterStories.ts` holds six original short stories: four English
(grades 1–3) and two Filipino (grades 1–2). They are bundled with the app so a new
device can practise offline immediately. `npm run seed:generate` writes the same
stories, with the same IDs, into `supabase/seed.sql` as published library stories.

Story text is plain text. Paragraphs are separated by a blank line. The tokenizer
(`src/text/tokenize.ts`, version 1) assigns stable word and sentence IDs per immutable
story version.

## Vocabulary: review required

`src/content/starterVocabulary.ts` has 23 child-friendly definitions with examples,
written for the starter stories. **They have not been reviewed by an educator.**
Every entry is marked `draft`, and the app labels it "Draft definition — not yet
checked by a teacher".

Syllable divisions are intentionally empty. The app shows syllables only when
`syllables_verified = true`, and never guesses them with a vowel-counting rule.

To review entries (as an admin or content editor, in the SQL editor):

```sql
update public.vocabulary_entries
set definition = '…', example = '…', syllables = 'pud·dle', syllables_verified = true,
    review_status = 'reviewed', reviewed_by = '<reviewer uuid>', reviewed_at = now()
where language = 'en' and normalized = 'puddle';
```

Downloading reviewed server vocabulary into the app is not implemented yet. The app
uses the bundled list. See the known limitations in the README.

## Filipino content

Filipino stories can be read, recorded and practised. Word checking stays off for
Filipino until a recognizer is verified on Filipino child speech (`docs/SPEECH.md`).
A Filipino speaker should review the Filipino stories and definitions before
classroom use.
