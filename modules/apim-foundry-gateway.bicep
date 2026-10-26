param name string
param location string
param publisherEmail string
param publisherName string
param skuName string = 'StandardV2'
@minValue(1)
param skuCapacity int = 1
@allowed(['Enabled', 'Disabled'])
param publicNetworkAccess string = 'Enabled'
@allowed(['Enabled', 'Disabled'])
param natGatewayState string = 'Enabled'
@allowed(['None', 'External', 'Internal'])
param virtualNetworkType string = 'None'
param virtualNetworkSubnetResourceId string = ''
param contentUnderstandingApiPath string = 'contentunderstanding'
param acuEndpoint string
param secondaryAcuEndpoint string
param secondaryLocation string
param apiVersion string
@secure()
param pollingSigningKey string
@secure()
param subscriptionPrimaryKey string
@secure()
param subscriptionSecondaryKey string
param analysisLatencyThresholdSeconds int
param activeBackend string
param pollingTokenLifetimeSeconds int
param allowedBrowserOrigins array
param logAnalyticsRetentionInDays int = 30
param logAnalyticsPublicIngestionAccess string = 'Enabled'
param logAnalyticsPublicQueryAccess string = 'Enabled'

var regionalGatewayUrl = 'https://${name}.azure-api.net'
var corsOrigins = join(map(allowedBrowserOrigins, origin => '<origin>${replace(replace(replace(origin, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')}</origin>'), '')
var originsJson = string(allowedBrowserOrigins)
var corsOriginStrings = replace(replace(replace(replace(substring(originsJson, 1, max(0, length(originsJson) - 2)), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '\'', '&apos;')
var config = {
  'cu-endpoint': acuEndpoint
  'cu-api-version': apiVersion
  'cu-region': location
  'cu-secondary-region': secondaryLocation
  'cu-secondary-endpoint': secondaryAcuEndpoint
  'gateway-url': regionalGatewayUrl
  'gateway-name': name
  'latency-threshold': string(analysisLatencyThresholdSeconds)
  'routing-state-url': 'https://management.azure.com${apim.id}/namedValues/active-backend?api-version=2024-05-01'
  'token-lifetime': string(pollingTokenLifetimeSeconds)
  'analyzers-ready': 'false'
}
var operations = [
  { name: 'analyze', method: 'POST', path: '/analyzers/{analyzerId}:analyze' }
  { name: 'analyze-binary', method: 'POST', path: '/analyzers/{analyzerId}:analyzeBinary' }
  { name: 'get-result', method: 'GET', path: '/analyzerResults/{operationId}' }
]

resource apim 'Microsoft.ApiManagement/service@2024-05-01' = {
  name: name
  location: location
  sku: { name: skuName, capacity: skuCapacity }
  identity: { type: 'SystemAssigned' }
  properties: {
    publisherEmail: publisherEmail
    publisherName: publisherName
    publicNetworkAccess: publicNetworkAccess
    natGatewayState: natGatewayState
    virtualNetworkType: virtualNetworkType
    virtualNetworkConfiguration: empty(virtualNetworkSubnetResourceId) ? null : { subnetResourceId: virtualNetworkSubnetResourceId }
    customProperties: {
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Backend.Protocols.Ssl30': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Backend.Protocols.Tls10': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Backend.Protocols.Tls11': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Ssl30': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls10': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls11': 'False'
    }
  }
}

resource namedValues 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = [for item in items(config): {
  parent: apim
  name: item.key
  properties: {
    displayName: item.key
    value: item.value
    secret: false
  }
}]

resource signingKey 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = {
  parent: apim
  name: 'polling-signing-key'
  properties: {
    displayName: 'polling-signing-key'
    value: pollingSigningKey
    secret: true
  }
}

// No shared native breaker: existing results must remain retrievable.
resource primaryCu 'Microsoft.ApiManagement/service/backends@2024-05-01' = {
  parent: apim
  name: 'primary-cu'
  properties: {
    url: '${acuEndpoint}contentunderstanding'
    protocol: 'http'
    description: 'Primary CU; accepted operations remain pinned here after failover.'
  }
}

resource secondaryCu 'Microsoft.ApiManagement/service/backends@2024-05-01' = {
  parent: apim
  name: 'secondary-cu'
  properties: {
    url: '${secondaryAcuEndpoint}contentunderstanding'
    protocol: 'http'
    description: 'Secondary CU; sticky new-work destination after failover.'
  }
}

resource routingState 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = {
  parent: apim
  name: 'active-backend'
  properties: { displayName: 'active-backend', value: activeBackend, secret: false }
}

resource routingWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(routingState.id, apim.id, 'routing-writer')
  scope: routingState
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '312a565d-c81f-4fd8-895a-4e21e48d571c')
    principalId: apim.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource switchPolicy 'Microsoft.ApiManagement/service/policyFragments@2024-05-01' = {
  parent: apim
  name: 'cu-switch-backend'
  properties: {
    format: 'rawxml'
    description: 'Conditional primary-to-secondary routing update; never replay the analysis.'
    value: loadTextContent('../policies/switch-backend.xml')
  }
  dependsOn: [namedValues, routingState]
}

resource api 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: 'content-understanding'
  properties: {
    displayName: 'Content Understanding - regional backend failover'
    path: contentUnderstandingApiPath
    protocols: ['https']
    subscriptionRequired: true
    subscriptionKeyParameterNames: {
      header: 'Ocp-Apim-Subscription-Key'
      query: 'subscription-key'
    }
  }
}

resource apiOperations 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = [for operation in operations: {
  parent: api
  name: operation.name
  properties: {
    displayName: operation.name
    method: operation.method
    urlTemplate: operation.path
    templateParameters: [
      {
        name: operation.method == 'POST' ? 'analyzerId' : 'operationId'
        type: 'string'
        required: true
      }
    ]
  }
}]

resource apiPolicy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = {
  parent: api
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: replace(replace(loadTextContent('../policies/content-understanding.xml'), '__CORS_ORIGINS__', corsOrigins), '__CORS_ORIGIN_STRINGS__', corsOriginStrings)
  }
  dependsOn: [namedValues, signingKey, primaryCu, secondaryCu, routingState, switchPolicy, routingWriter, apiOperations]
}

resource servingSubscription 'Microsoft.ApiManagement/service/subscriptions@2024-05-01' = {
  parent: apim
  name: 'foundry-content-understanding-sub'
  properties: {
    displayName: 'Content Understanding client'
    scope: api.id
    state: 'active'
    primaryKey: subscriptionPrimaryKey
    secondaryKey: subscriptionSecondaryKey
    allowTracing: false
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    retentionInDays: logAnalyticsRetentionInDays
    publicNetworkAccessForIngestion: logAnalyticsPublicIngestionAccess
    publicNetworkAccessForQuery: logAnalyticsPublicQueryAccess
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${name}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

resource logger 'Microsoft.ApiManagement/service/loggers@2024-05-01' = {
  parent: apim
  name: 'cu-observations'
  properties: {
    loggerType: 'applicationInsights'
    credentials: { instrumentationKey: insights.properties.InstrumentationKey }
    resourceId: insights.id
    isBuffered: true
  }
}

resource diagnostics 'Microsoft.ApiManagement/service/apis/diagnostics@2024-05-01' = {
  parent: api
  name: 'applicationinsights'
  properties: {
    loggerId: logger.id
    alwaysLog: 'allErrors'
    verbosity: 'information'
    logClientIp: false
    httpCorrelationProtocol: 'W3C'
    sampling: { samplingType: 'fixed', percentage: 100 }
    frontend: {
      request: {
        headers: []
        body: { bytes: 0 }
        dataMasking: {
          queryParams: [
            { mode: 'Hide', value: 'gateway-token' }
            { mode: 'Hide', value: 'subscription-key' }
          ]
        }
      }
      response: { headers: [], body: { bytes: 0 } }
    }
    backend: {
      request: { headers: [], body: { bytes: 0 } }
      response: { headers: [], body: { bytes: 0 } }
    }
  }
}

output principalId string = apim.identity.principalId
output resourceId string = apim.id
output gatewayHostname string = '${name}.azure-api.net'
output contentUnderstandingUrl string = '${regionalGatewayUrl}/${contentUnderstandingApiPath}'
