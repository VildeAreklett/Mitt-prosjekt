import { NextResponse } from 'next/server';

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Ikke tilgjengelig i produksjon' }, { status: 404 });
  }

  const authUrl = process.env.POGO_AUTH_URL!;
  const baseUrl = process.env.POGO_BASE_URL!;
  const appKey = process.env.POGO_APPLICATION_KEY!;
  const clientKey = process.env.POGO_CLIENT_KEY!;
  const subKey = process.env.POGO_SUBSCRIPTION_KEY!;

  const basicAuth = Buffer.from(`${appKey}:${clientKey}`).toString('base64');

  const tokenRes = await fetch(authUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Ocp-Apim-Subscription-Key': subKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const tokenRawText = await tokenRes.text();

  if (!tokenRes.ok) {
    return NextResponse.json({ step: 'auth', status: tokenRes.status, raw: tokenRawText });
  }

  let tokenData;
  try {
    tokenData = JSON.parse(tokenRawText);
  } catch {
    return NextResponse.json({ step: 'auth-parse', status: tokenRes.status, raw: tokenRawText });
  }

  const accessToken = tokenData.access_token;

  const customersRes = await fetch(`${baseUrl}/customers/`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Ocp-Apim-Subscription-Key': subKey,
    },
  });

  const customersRawText = await customersRes.text();

  if (!customersRes.ok) {
    return NextResponse.json({ step: 'customers', status: customersRes.status, raw: customersRawText });
  }

  let customers;
  try {
    customers = JSON.parse(customersRawText);
  } catch {
    return NextResponse.json({ step: 'customers-parse', status: customersRes.status, raw: customersRawText });
  }

  return NextResponse.json({ success: true, customers });
}


