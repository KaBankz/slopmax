// Images the bundler copies beside the build and imports as their URL.
declare module "*.png" {
  const url: string
  export default url
}
declare module "*.svg" {
  const url: string
  export default url
}
