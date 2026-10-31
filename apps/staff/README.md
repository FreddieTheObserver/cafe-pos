# Staff app

Kitchen display (KDS) and sold-out toggle. Staff sign in with their API account.
Set `VITE_API_URL` to the API origin (default `http://localhost:3000`); that origin must be in the API's `CORS_ORIGINS`.
The refresh token is kept in `sessionStorage`, so closing the tab signs out.
