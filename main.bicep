targetScope = 'resourceGroup'

@description('Publisher email for the single gateway.')
param publisherEmail string
param publisherName string
@description('Primary CU and single APIM region. Choose both regions before the first deployment.')
param primaryLocation string = 'swedencentral'
@description('Secondary CU region; must differ from primaryLocation and support the selected models.')
param secondaryLocation string = 'westeurope'

@description('Resource-name region code: swc for Sweden Central, weu for West Europe, otherwise the location ID. Override for other naming conventions.')
@minLength(2)
@maxLength(24)
param primaryRegionCode string = primaryLocation == 'swedencentral' ? 'swc' : primaryLocation == 'westeurope' ? 'weu' : toLower(primaryLocation)
@description('Resource-name region code only; this does not change secondaryLocation.')
@minLength(2)
@maxLength(24)
param secondaryRegionCode string = secondaryLocation == 'swedencentral' ? 'swc' : secondaryLocation == 'westeurope' ? 'weu' : toLower(secondaryLocation)

param foundrySkuName string = 'S0'
@allowed(['Enabled', 'Disabled'])
param foundryPublicNetworkAccess string = 'Enabled'
@allowed(['Allow', 'Deny'])
param foundryNetworkAclsDefaultAction string = 'Allow'
param foundryAllowProjectManagement bool = true
@description('Fresh-install name; deployment tooling preserves recorded Foundry names on redeployment.')
param primaryFoundryName string = 'foundry-${toLower(primaryRegionCode)}-${take(uniqueString(subscription().id, resourceGroup().id, primaryLocation, 'primary'), 6)}'
@description('Fresh-install name; override explicitly to recover an existing account when outputs are unavailable.')
param secondaryFoundryName string = 'foundry-${toLower(secondaryRegionCode)}-${take(uniqueString(subscription().id, resourceGroup().id, secondaryLocation, 'secondary'), 6)}'
param modelDeploymentName string = 'gpt-5.2'
param modelName string = 'gpt-5.2'
param modelVersion string = '2025-12-11'
@allowed(['GlobalStandard', 'DataZoneStandard', 'Standard'])
param modelDeploymentSkuName string = 'GlobalStandard'
param modelVersionUpgradeOption string = 'NoAutoUpgrade'
@minValue(1)
param modelCapacity int = 10
param embeddingDeploymentName string = 'text-embedding-3-large'
param embeddingModelName string = 'text-embedding-3-large'
param embeddingModelVersion string = '1'
@allowed(['GlobalStandard', 'DataZoneStandard', 'Standard'])
param embeddingDeploymentSkuName string = modelDeploymentSkuName
param embeddingModelVersionUpgradeOption string = 'NoAutoUpgrade'
@minValue(1)
param embeddingCapacity int = 10

param primaryApimName string = 'apim-foundry-${uniqueString(subscription().id, resourceGroup().id, primaryLocation, 'primary')}'
param apimSkuName string = 'StandardV2'
@minValue(1)
param apimCapacity int = 1
@allowed(['Enabled', 'Disabled'])
param apimPublicNetworkAccess string = 'Enabled'
@allowed(['Enabled', 'Disabled'])
param apimNatGatewayState string = 'Enabled'
@allowed(['None', 'External', 'Internal'])
param apimVirtualNetworkType string = 'None'
param apimVirtualNetworkSubnetResourceId string = ''
param contentUnderstandingApiPath string = 'contentunderstanding'
param contentUnderstandingApiVersion string = '2025-11-01'
param foundryModelConnectionName string = 'aoai-local'

@description('Primary POST-to-result elapsed seconds: a pending or successful result strictly beyond this duration switches new work to secondary.')
@minValue(1)
param analysisLatencyThresholdSeconds int = 60
@allowed(['primary-cu', 'secondary-cu'])
param activeBackend string = 'primary-cu'
@description('Polling-token lifetime; keep within the CU result retention period.')
@minValue(60)
@maxValue(86400)
param pollingTokenLifetimeSeconds int = 86400
@description('Exact allowed browser origins. No wildcard origins.')
param allowedBrowserOrigins array = [
  'http://localhost:5173'
  'http://127.0.0.1:5173'
]

// The deployment script creates these once and preserves them on redeployment.
// Empty defaults support compile/what-if; the gateway fails closed without real keys.
@secure()
param primaryPollingSigningKey string = ''
@secure()
param servingSubscriptionPrimaryKey string = ''
@secure()
param servingSubscriptionSecondaryKey string = ''

@minValue(30)
param logAnalyticsRetentionInDays int = 30
@allowed(['Enabled', 'Disabled'])
param logAnalyticsPublicIngestionAccess string = 'Enabled'
@allowed(['Enabled', 'Disabled'])
param logAnalyticsPublicQueryAccess string = 'Enabled'

var regions = [
  {
    location: primaryLocation
    foundryName: primaryFoundryName
  }
  {
    location: secondaryLocation
    foundryName: secondaryFoundryName
  }
]
var cognitiveServicesUserRoleId = 'a97b65f3-24c7-4388-baec-2e87135dc908'

module foundry 'modules/foundry-resource.bicep' = [for (region, i) in regions: {
  name: 'foundry-${i}'
  params: {
    name: region.foundryName
    location: region.location
    skuName: foundrySkuName
    allowProjectManagement: foundryAllowProjectManagement
    publicNetworkAccess: foundryPublicNetworkAccess
    networkAclsDefaultAction: foundryNetworkAclsDefaultAction
    modelDeploymentName: modelDeploymentName
    modelName: modelName
    modelVersion: modelVersion
    modelDeploymentSkuName: modelDeploymentSkuName
    modelVersionUpgradeOption: modelVersionUpgradeOption
    modelCapacity: modelCapacity
    embeddingDeploymentName: embeddingDeploymentName
    embeddingModelName: embeddingModelName
    embeddingModelVersion: embeddingModelVersion
    embeddingDeploymentSkuName: embeddingDeploymentSkuName
    embeddingModelVersionUpgradeOption: embeddingModelVersionUpgradeOption
    embeddingCapacity: embeddingCapacity
  }
}]

module gateway 'modules/apim-foundry-gateway.bicep' = {
  name: 'apim'
  params: {
    name: primaryApimName
    location: primaryLocation
    publisherEmail: publisherEmail
    publisherName: publisherName
    skuName: apimSkuName
    skuCapacity: apimCapacity
    publicNetworkAccess: apimPublicNetworkAccess
    natGatewayState: apimNatGatewayState
    virtualNetworkType: apimVirtualNetworkType
    virtualNetworkSubnetResourceId: apimVirtualNetworkSubnetResourceId
    contentUnderstandingApiPath: contentUnderstandingApiPath
    acuEndpoint: foundry[0].outputs.endpoint
    secondaryAcuEndpoint: foundry[1].outputs.endpoint
    secondaryLocation: secondaryLocation
    apiVersion: contentUnderstandingApiVersion
    pollingSigningKey: primaryPollingSigningKey
    subscriptionPrimaryKey: servingSubscriptionPrimaryKey
    subscriptionSecondaryKey: servingSubscriptionSecondaryKey
    analysisLatencyThresholdSeconds: analysisLatencyThresholdSeconds
    activeBackend: activeBackend
    pollingTokenLifetimeSeconds: pollingTokenLifetimeSeconds
    allowedBrowserOrigins: allowedBrowserOrigins
    logAnalyticsRetentionInDays: logAnalyticsRetentionInDays
    logAnalyticsPublicIngestionAccess: logAnalyticsPublicIngestionAccess
    logAnalyticsPublicQueryAccess: logAnalyticsPublicQueryAccess
  }
}

module gatewayToFoundry 'modules/foundry-role-assignment.bicep' = [for (region, i) in regions: {
  name: 'ra-gateway-cu-${i}'
  params: {
    foundryName: region.foundryName
    principalId: gateway.outputs.principalId
    roleDefinitionId: cognitiveServicesUserRoleId
  }
}]

module foundryModelUser 'modules/foundry-role-assignment.bicep' = [for (region, i) in regions: {
  name: 'ra-foundry-local-model-${i}'
  params: {
    foundryName: region.foundryName
    principalId: foundry[i].outputs.principalId
  }
}]

module modelConnections 'modules/foundry-aoai-connection.bicep' = [for (region, i) in regions: {
  name: 'connection-${i}'
  params: {
    acuName: region.foundryName
    connectionName: foundryModelConnectionName
    aoaiEndpoint: foundry[i].outputs.endpoint
    aoaiResourceId: foundry[i].outputs.resourceId
    aoaiLocation: region.location
  }
  dependsOn: [foundryModelUser]
}]

output contentUnderstandingUrl string = gateway.outputs.contentUnderstandingUrl
output primaryApimName string = primaryApimName
output gatewayResourceId string = gateway.outputs.resourceId
output primaryRegion string = primaryLocation
output secondaryRegion string = secondaryLocation
output primaryAcuEndpoint string = foundry[0].outputs.endpoint
output secondaryAcuEndpoint string = foundry[1].outputs.endpoint
output primaryFoundryResourceId string = foundry[0].outputs.resourceId
output secondaryFoundryResourceId string = foundry[1].outputs.resourceId
output deployedModelName string = modelDeploymentName
output deployedEmbeddingModelName string = embeddingDeploymentName
output deployedModelSkuName string = modelDeploymentSkuName
