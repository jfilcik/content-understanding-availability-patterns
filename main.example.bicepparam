using './main.bicep'

// Copy to the ignored main.bicepparam. Deploy with scripts/deploy.ps1 or deploy.sh.
// Never put subscription keys or polling-signing secrets in this file.
param publisherEmail = 'noreply@contoso.com'
param publisherName = 'Contoso'
// Choose two different regions BEFORE the first deployment.
// Both need CU, the selected completion/embedding models, SKU and quota.
param primaryLocation = 'swedencentral' // Default: Sweden Central (APIM + primary CU).
param secondaryLocation = 'westeurope' // Default: West Europe (secondary CU).
// Names default to foundry-swc-<6 chars> / foundry-weu-<6 chars>.
// Other locations use their location ID unless you supply a short naming code.
// param primaryRegionCode = 'swc'
// param secondaryRegionCode = 'weu'
// Recovery without recorded outputs: retain the existing resource names.
// param primaryFoundryName = '<existing-primary-foundry-name>'
// param secondaryFoundryName = '<existing-secondary-foundry-name>'

param modelDeploymentName = 'gpt-5.2'
param modelName = 'gpt-5.2'
param modelVersion = '2025-12-11'
param modelDeploymentSkuName = 'GlobalStandard'
param modelCapacity = 10
param embeddingDeploymentName = 'text-embedding-3-large'
param embeddingModelName = 'text-embedding-3-large'
param embeddingModelVersion = '1'
param embeddingDeploymentSkuName = 'GlobalStandard'
param embeddingCapacity = 10

param contentUnderstandingApiVersion = '2025-11-01'
param analysisLatencyThresholdSeconds = 60
param activeBackend = 'primary-cu'
param pollingTokenLifetimeSeconds = 86400
param allowedBrowserOrigins = [
  'http://localhost:5173'
  'http://127.0.0.1:5173'
]
