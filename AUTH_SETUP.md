# Student sign-in and work history setup

This branch adds Google sign-in, student work history, and restricted session-code lookup to the existing single-page Classwork app.

## Before publishing Firestore rules

**Do not publish the rules until the app changes have been tested in a Firebase test project.** Rules changes can block older assignment records or work created by previous versions.

1. In Firebase Console, open **Authentication → Sign-in method** and enable **Google**.
2. Under **Authentication → Settings → Authorized domains**, ensure the deployed GitHub Pages domain and any custom domain are listed.
3. Deploy the matching `firestore.rules` from this branch only after reviewing and testing it. Do not combine it with an older version of `index.html`.
4. In Firestore, create/update `users/<your Firebase Auth UID>` and set `role: "teacher"` for each trusted teacher. Assign this role manually in the console; never let a user assign their own role.
5. Confirm teacher-owned assignment documents include `teacherId` matching that teacher's Firebase UID. Existing assignment documents without this field will not be writable by the teacher under these rules.
6. Test in a separate test project or with test accounts before using real student data.

## Session-code lookup

- New assignments are written to `assignments/<assignmentId>`. Assignment documents store a count of assigned students, not the email roster.
- Teachers assign an assignment to individual students or a class by entering the relevant Google email addresses in the assignment form. The optional class/group label is shown in student history.
- Each assigned student has a private-to-that-student `assignments/<assignmentId>/assignedStudents/<email>` record with the initial `assignment-started` status.
- A separate `assignmentLookups/<SESSION_CODE>` document contains only the assignment ID, session code, teacher UID, title, status, and creation timestamp. It does not contain slide prompts, background URLs, or student work.
- Students can see assignments addressed to their signed-in Google email before joining. Starting an assigned assignment creates their membership record and changes the status to `in-progress`. The student must be included in the assignment audience to join.
- Signed-in users can read a lookup when they know its code, but cannot list the lookup collection.
- The teacher app attempts to create/update the lookup when a teacher opens an existing assignment. This does not automatically migrate every old assignment in the database.

## Data behavior

- Google sign-in uses a stable Firebase UID.
- Canvas work is stored under `assignments/<assignmentId>/students/<uid>/slides/<slideId>`.
- A history index is stored under `users/<uid>/submissions/<assignmentId>`.
- Student history is private to that student and combines assigned-work records with the student's own submission history.
- Status transitions are `assignment-started` (teacher assigns), `in-progress` (student starts or revises), `submitted` (student submits for review), and `completed` (teacher accepts). The teacher's **Amendments Needed** action returns the work to `in-progress`.
- Submitted and completed work is read-only in the student canvas. Teacher review actions are restricted by Firestore rules.
- Teacher access to assignment and student work is limited by the manually assigned teacher role and assignment ownership.
- Legacy timestamp-ID student records are not automatically attributed to a Google account.
- Canvas images are currently stored as data URLs in Firestore. Large drawings may hit Firestore's document-size limit; moving images to Cloud Storage is a follow-up improvement.

## Smoke-test checklist

- [ ] Sign in with Google; refresh the page and confirm the session persists.
- [ ] As a teacher, create a test assignment for one or more test student email addresses and confirm the assignment, lookup, and assigned-student records appear.
- [ ] Sign in with a listed student account and confirm the assignment appears as **Assignment Started** before joining.
- [ ] Start the assignment and confirm the status changes to **In Progress**.
- [ ] Draw on the canvas and submit the work; confirm the status changes to **Submitted** and editing is blocked.
- [ ] As the teacher, mark the work **Completed** and confirm the student sees the completed status; repeat with **Amendments Needed** and confirm the student can edit again.
- [ ] Confirm a Google account not in the assignment audience cannot join that assignment.
- [ ] Sign in with a separate student account and join using the code.
- [ ] Draw on slide 1 and slide 2; verify canvas data saves in Firestore.
- [ ] Sign out and back in, open **Student Portal → My Past Work → Reopen work**, and verify the saved work restores.
- [ ] Confirm the teacher sees the student in Live Student Monitoring and can inspect the student's slides.
- [ ] Confirm the student cannot read another student's history or another assignment's content without joining it.
- [ ] Confirm an unprivileged account cannot create assignments or read student work for an assignment it does not own.
- [ ] Confirm a student cannot grant themselves the teacher role.

Automated browser integration tests and Firebase Rules Emulator tests have not been run by this repository edit. Complete the checklist in a Firebase test project before production use.

## Canvas image storage

- While a student is actively working, the current canvas snapshot continues to sync through Firestore so the existing teacher live-view workflow remains intact.
- On student submission, each saved slide image is uploaded to Cloud Storage under `student-work/<assignmentId>/<studentUid>/<slideId>.jpg`. After a successful upload, the large Firestore `canvasData` field is removed and replaced with `canvasStoragePath`.
- The teacher view loads archived slides from Storage. When a teacher finishes review, the latest annotated canvas is archived again.
- Before enabling this feature in production, publish the repository's `storage.rules` in Firebase Console → Storage → Rules. Test with a teacher account and student account first. Storage rules use Firestore membership and assignment ownership to authorize access.
- This change archives canvas slides only. Existing assignment question images stored as Base64 data URLs in Firestore are not migrated by this feature.
