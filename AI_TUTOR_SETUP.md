# S.T.E.P. AI Tutor backend

The GitHub Pages frontend calls the Firebase callable function helpMeStart in the existing Firebase project classwork1314, region asia-southeast1.

## Prerequisites
- Node.js 20
- Firebase CLI (npm install -g firebase-tools)
- Access to the classwork1314 Firebase project
- An OpenAI API key with API billing configured

## Configure and deploy
Run these commands from the repository root in PowerShell or a terminal:

```powershell
npm install -g firebase-tools
firebase login
firebase use classwork1314
cd functions
npm install
cd ..
firebase functions:secrets:set OPENAI_API_KEY
firebase deploy --only functions:helpMeStart --project classwork1314
```

When prompted by firebase functions:secrets:set, paste the OpenAI API key into the terminal prompt. Do not paste the key into source files, GitHub, browser JavaScript, chat messages, or a public issue. The key is stored as a Firebase secret and only the server-side function can read it.

Cloud Functions deployment may require the Firebase project to use the Blaze (pay-as-you-go) plan. OpenAI API billing is separate from any ChatGPT subscription.

## Firestore security rule required for usage counters
Add this rule to the existing Firestore rules without replacing the other rules:

```
match /aiTutorUsage/{uid} {
  allow read, write: if false;
}
```

The Admin SDK in the Cloud Function can still write usage counters. Client-side users cannot read or change their quota.

## Test
1. Deploy the function successfully.
2. Open the GitHub Pages S.T.E.P. site and sign in.
3. Join an assignment as a student.
4. Open a slide with question text or a question image.
5. Press Help Me Start and confirm a short hint appears.
6. Test Check my step, Give me another hint, and Show a similar example.
7. Confirm the OpenAI API key does not appear in browser DevTools or any repository file.

## Notes
- The frontend uses the Firebase Functions compatibility SDK and calls the function in asia-southeast1.
- The function verifies Firebase Authentication and that the signed-in student has a joined-student record for the assignment.
- The function allows up to 25 AI requests per student per rolling hour window, with a two-second minimum gap between requests.
- Uploaded question images are resized in the browser before being sent. Image-only questions are supported when the uploaded image is readable.
- Before wider student rollout, consider enabling Firebase App Check and monitoring Firebase/OpenAI usage and billing.
