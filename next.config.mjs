/** @type {import('next').NextConfig} */
const nextConfig = {
  // context/*.md are read at runtime (FR18); make sure Vercel bundles them with the serverless functions.
  outputFileTracingIncludes: { "/api/**/*": ["./context/**/*"], "/dashboard": ["./context/**/*"] },
};
export default nextConfig;
