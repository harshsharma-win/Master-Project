/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['localhost', '127.0.0.1', '172.24.246.240'],
  images: {
    unoptimized: true,
  },
}

export default nextConfig
