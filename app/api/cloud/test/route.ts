import { NextResponse } from 'next/server';

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Ikke tilgjengelig i produksjon' }, { status: 404 });
  }

  const baseUrl = 'https://api.adaptic.no/v1';
  const token = process.env.CLOUD_API_TOKEN;
  const orgId = '3f055216-6a82-406d-a827-4fc3ae7e650a'; // Adaptic AS, for test

  const tokenLength = token?.length ?? 0;

  if (!token || tokenLength < 100) {
    return NextResponse.json({ error: 'Token ser ufullstendig ut', tokenLength });
  }

  const res = await fetch(`${baseUrl}/buildings`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Org-Id': orgId,
    },
  });

  const rawText = await res.text();

  if (!res.ok) {
    return NextResponse.json({ status: res.status, raw: rawText, tokenLength });
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    return NextResponse.json({ status: res.status, parseError: true, raw: rawText });
  }

  return NextResponse.json({ success: true, data });
}