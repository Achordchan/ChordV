package buildinfo

// GitHub builds inject these through -ldflags; local source runs stay explicit.
var Version = "dev"
var Commit = ""
var BuiltAt = ""
var AgentManifestSHA256 = ""
