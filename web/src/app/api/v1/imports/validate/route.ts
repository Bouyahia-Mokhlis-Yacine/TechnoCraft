// POST /api/v1/imports/validate (multipart, field "file"): backend validation of a transaction CSV.
// Returns counts, date range, merchants, duplicates, blocking errors, handled warnings and a
// card-free preview. Administrator only. The file is kept (owner-readable) only when it is valid.
import type { NextRequest } from 'next/server';
import { fail, userOf } from '@/lib/http';
import { can } from '@/lib/session';
import { checkUpload, MAX_BYTES } from '@/lib/imports';

export async function POST(req: NextRequest) {
  const user = userOf(req);
  if (!user) return fail(401, 'unauthenticated', 'Sign in first.');
  if (!can(user, 'import')) return fail(403, 'forbidden', 'Only the administrator can import transactions.');
  let form: FormData;
  try { form = await req.formData(); } catch { return fail(400, 'invalid_form', 'Send the file as multipart form data.'); }
  const file = form.get('file');
  if (!(file instanceof File)) return fail(422, 'missing_file', 'Choose a CSV file.');
  if (!/\.csv$/i.test(file.name)) return fail(422, 'not_csv', 'The file must be a .csv file.');
  if (file.size > MAX_BYTES) return fail(413, 'too_large', `The file is larger than ${MAX_BYTES / 1024 / 1024} MB. Split it by date.`);
  try {
    const name = file.name.replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    return Response.json(await checkUpload(Buffer.from(await file.arrayBuffer()), name));
  } catch {
    return fail(500, 'validation_failed', 'The backend could not validate this file. Check that it is a UTF-8 CSV.');
  }
}
