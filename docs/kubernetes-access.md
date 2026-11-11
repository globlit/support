# Kubernetes access

The agent reads clusters with `kubectl`, `flux` and `helm template` in the command sandbox. The sandbox has no cluster credential. Its kubeconfig points at the agent gateway of Support. The gateway adds the token of the context and forwards the request to the API server.

## What limits the agent

| Layer | Enforced by | Effect |
| --- | --- | --- |
| Cluster RBAC | The API server | Decides which resources the token can read. This is the main limit. |
| Gateway | Support | Forwards `GET` and `HEAD` only. Refuses connection upgrades, and the `exec`, `attach`, `portforward` and `proxy` subresources. Drops `Authorization` and `Impersonate-*` headers sent by the agent. |
| Context switch | Settings | A disabled context is left out of the agent kubeconfig and refused by the gateway. |

Support does not redact Kubernetes output. Values stored outside Secrets, such as environment variables, ConfigMaps and HelmRelease values, reach the model as they are.

## Create a read-only ServiceAccount

Apply this manifest in each cluster, for example through Flux. The `view` ClusterRole reads most namespaced resources and excludes Secrets ([Kubernetes user-facing roles](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#user-facing-roles)).

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: support-agent
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: support-agent
  namespace: support-agent
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: support-agent-view
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: view
subjects:
  - kind: ServiceAccount
    name: support-agent
    namespace: support-agent
---
# Long-lived token for the ServiceAccount. The token controller fills data.token.
apiVersion: v1
kind: Secret
metadata:
  name: support-agent-token
  namespace: support-agent
  annotations:
    kubernetes.io/service-account.name: support-agent
type: kubernetes.io/service-account-token
```

Long-lived token Secrets are described in [ServiceAccount token Secrets](https://kubernetes.io/docs/concepts/configuration/secret/#serviceaccount-token-secrets). To use a token that expires instead, create it with `kubectl create token support-agent -n support-agent --duration=720h` and replace it in Support before it expires.

Read the token:

```shell
kubectl -n support-agent get secret support-agent-token -o jsonpath='{.data.token}' | base64 -d
```

### Optional permissions

`view` covers the resources of a custom resource definition only when a ClusterRole of that definition aggregates to `view`. Check with `kubectl auth can-i list kustomizations.kustomize.toolkit.fluxcd.io --as=system:serviceaccount:support-agent:support-agent -A`. When the answer is `no`, bind an extra ClusterRole:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: support-agent-crds
rules:
  - apiGroups:
      - kustomize.toolkit.fluxcd.io
      - helm.toolkit.fluxcd.io
      - source.toolkit.fluxcd.io
      - notification.toolkit.fluxcd.io
      - argoproj.io
    resources: ["*"]
    verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: support-agent-crds
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: support-agent-crds
subjects:
  - kind: ServiceAccount
    name: support-agent
    namespace: support-agent
```

Prometheus servers configured **Through Kubernetes** in **Settings → Connections → Prometheus** are read through the API server proxy. They need `get` on `services/proxy` in their namespace. The gateway refuses the proxy subresource to the agent, so this permission is used by Support only.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: support-agent-prometheus
  namespace: monitoring
rules:
  - apiGroups: [""]
    resources: [services/proxy]
    resourceNames: [prometheus-operated]
    verbs: [get]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: support-agent-prometheus
  namespace: monitoring
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: support-agent-prometheus
subjects:
  - kind: ServiceAccount
    name: support-agent
    namespace: support-agent
```

## Add the contexts in Support

Open **Settings → Connections → Kubernetes**.

- **Import kubeconfig files…** merges the files with `kubectl config view --flatten`. Each context with a bearer token is added, or updated when a context of the same name exists. New contexts start disabled. Contexts that sign in with an exec plugin, an auth provider, a client certificate, a token file or a password are listed as not imported.
- **Add a context** takes a name, the API server URL, a token and optional CA certificates in PEM format.
- The checkbox of each context enables it for the agent. **Remove** deletes the context and, after **Save settings**, its token.
- **Test** reads `/version` with the saved token.

Tokens and CA certificates are saved in the Vault as `Kubernetes/<context>` when you click **Save settings**.

## What works in the sandbox

| Command | Result |
| --- | --- |
| `kubectl get`, `describe`, `logs`, `events`, `api-resources`, `-o yaml`, `-o json`, `-o jsonpath` | Work, within RBAC. |
| `kubectl apply`, `create`, `delete`, `edit`, `patch`, `scale` | Refused by the gateway. |
| `kubectl exec`, `attach`, `port-forward`, `proxy`, `cp` | Refused by the gateway. |
| `kubectl get secrets` | Refused by RBAC with the `view` role. |
| `flux get`, `tree`, `events`, `logs` | Work, within RBAC and the optional CRD permissions. |
| `flux reconcile`, `suspend`, `resume` | Refused by the gateway. |
| `helm template`, `show`, `lint` | Work. They do not read the cluster. |
| `helm list`, `get`, `history`, `status` | Fail with the `view` role: Helm stores releases in Secrets by default ([Helm storage backends](https://helm.sh/docs/topics/advanced/#storage-backends)). Read the HelmRelease objects instead. |
| `argocd` | Cannot reach Argo CD: the sandbox has no Argo CD token, and `--core` mode port-forwards to Argo CD components. Read `applications.argoproj.io` with `kubectl`. |
