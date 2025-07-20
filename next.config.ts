import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    /* config options here */
    images: {
        remotePatterns: [
            { hostname: "brazen-scorpion-212.convex.cloud", protocol: "https" },
        ],
    },
};

export default nextConfig;
