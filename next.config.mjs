// Turbopack may not resolve firebase subpath exports; alias to ESM entry
const firebaseBase = "./node_modules/firebase"

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  turbopack: {
    resolveAlias: {
      "firebase/app": `${firebaseBase}/app/dist/esm/index.esm.js`,
      "firebase/auth": `${firebaseBase}/auth/dist/esm/index.esm.js`,
      "firebase/firestore": `${firebaseBase}/firestore/dist/esm/index.esm.js`,
    },
  },
}

export default nextConfig
