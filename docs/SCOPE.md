# Project scope and educational alignment

## Who and what it is for

Tinig Turo is an English reading platform for elementary learners in **Grades 2–4**.
It supports:

- guided oral reading, with the app following the reader's voice;
- vocabulary development (Word Coach, My Words, practice);
- teacher-assigned lessons;
- evidence-based assessment that says what was measured and how;
- teacher review and teacher-validated grades;
- offline practice;
- a learning progression from Grade 2 to Grade 4 reading levels.

## The default learning path

The **Grades 2–4 English** path is what learners see first:

- The story list opens on it.
- Its reading-level filter offers Grades 2, 3 and 4.
- A teacher's assignment always shows, whatever its level, because the teacher chose it.

The rule lives in one place: `src/content/scope.ts`.

## Content outside the path

Nothing outside the path is deleted. Grade 1, 5 and 6 reading levels and Filipino
stories stay on the device and the server. They are shown under **All stories** and
labelled **Extra practice**, with the reason (for example "Grade 1 level" or "Filipino
story").

Filipino stories can be read, recorded and practised. Word checking stays off for
Filipino until a recognizer has been verified on Filipino child speech
(`docs/SPEECH.md`).

The bundled starter stories are categorised like this:

| Story | Language | Reading level | Category |
|---|---|---|---|
| Pip and the Puddle | English | Grade 1 | Extra practice |
| Rain on the Roof | English | Grade 1 | Extra practice |
| The Red Kite | English | Grade 2 | Learning path |
| Lola's Garden | English | Grade 3 | Learning path |
| Ang Pusa ni Lito | Filipino | Grade 1 | Extra practice |
| Sa Palengke | Filipino | Grade 2 | Extra practice |

**Content gap.** There are only two bundled in-path stories and no Grade 4 story.
Teachers and content editors add stories in the teacher workspace. Assigned stories
download to learners' devices automatically. New passages should be written or
approved by educators; the app does not generate them.

## Four things kept apart

| Concept | Where it lives | Never derived from |
|---|---|---|
| A learner's **school grade** (optional) | `LearnerProfile.gradeLevel`, `learners.grade_level` | reading level, scores or badges |
| A story's **reading level** | `StoryVersionRecord.gradeLevel`, shown as "Grade N reading level" | a learner's grade |
| **Academic performance** | Automated assessments (`session_assessments`) and teacher grades (`session_grades`) | rewards |
| **Rewards** | Participation and performance badges (`badge_awards`) | grades; badges never change a grade |

Some rules follow from this separation:

- A teacher grade is the teacher's own judgement, recorded against a rubric version.
- The automated word check is shown beside the grade for reference. It is never turned
  into a grade.
- Story coverage ("whole story" or "partial") is not mastery or a pass mark
  (`docs/SCORING.md`).

## Grading criteria are the school's

The app ships **no official grading criteria, weights, benchmarks or cut-offs**:

- Teachers create rubrics per class, with the criteria and final-grade terms their
  school uses.
- The "Fill in an example" rubric is labelled as an example to replace.
- Final grades are chosen by the teacher. They are not computed from criterion levels.

## SDG 4 alignment

Tinig Turo's primary alignment is **UN Sustainable Development Goal 4, Quality
Education**:

- **Target 4.1:** foundational literacy in primary school. The app gives practice in
  oral reading fluency and vocabulary.
- **Target 4.5:** equal access. The app works offline after installation, runs on
  low-cost phones, and needs no paid service, which can support learners with limited
  connectivity.

These describe what the app is **designed to support**. **No learning outcomes have
been demonstrated:**

- The app has not been evaluated with learners.
- Speech recognition accuracy on children's voices is unmeasured.
- Offline access supports inclusion only if it reaches and works for the intended
  learners, which needs field evaluation.

Any outcome claim needs an evaluation with an appropriate design, consent and ethics
review.
