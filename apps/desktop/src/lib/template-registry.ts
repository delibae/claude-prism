// ─── Template Data Architecture ───

export type TemplateCategory =
  | "academic"
  | "professional"
  | "creative"
  | "starter";

export type TemplateSubcategory =
  | "papers"
  | "theses"
  | "presentations"
  | "posters"
  | "cv"
  | "letters"
  | "reports"
  | "books"
  | "newsletters"
  | "blank";

export interface TemplatePackage {
  name: string;
  description: string;
}

export interface TemplateDefinition {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  subcategory: TemplateSubcategory;
  tags: string[];
  icon: string; // lucide icon name
  documentClass: string;
  mainFileName: string;
  content: string;
  packages: TemplatePackage[];
  /** Accent color for thumbnail placeholder */
  accentColor: string;
  /** Whether template uses bibliography */
  hasBibliography: boolean;
  /** Aspect ratio for card thumbnail (CSS aspect-ratio value) */
  aspectRatio: string;
}

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  academic: "Academic",
  professional: "Professional",
  creative: "Creative",
  starter: "Starter",
};

export const SUBCATEGORY_LABELS: Record<TemplateSubcategory, string> = {
  papers: "Papers",
  theses: "Theses & Dissertations",
  presentations: "Presentations",
  posters: "Posters",
  cv: "CV & Resume",
  letters: "Letters",
  reports: "Reports",
  books: "Books",
  newsletters: "Newsletters",
  blank: "Blank",
};

export const CATEGORY_SUBCATEGORIES: Record<
  TemplateCategory,
  TemplateSubcategory[]
> = {
  academic: ["papers", "theses", "presentations", "posters"],
  professional: ["cv", "letters", "reports"],
  creative: ["books", "newsletters"],
  starter: ["blank"],
};

// ─── Template Definitions ───

const TEMPLATES: TemplateDefinition[] = [
  {
    id: "paper-standard",
    name: "Research Paper",
    description: "Academic paper with abstract, sections, and references",
    category: "academic",
    subcategory: "papers",
    tags: [
      "article",
      "research",
      "journal",
      "academic",
      "science",
      "abstract",
      "bibliography",
    ],
    icon: "FileText",
    documentClass: "article",
    mainFileName: "main.tex",
    accentColor: "#3b82f6",
    hasBibliography: true,
    aspectRatio: "3/4",
    packages: [
      { name: "amsmath", description: "AMS mathematical typesetting" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "geometry", description: "Page layout customization" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
      { name: "booktabs", description: "Professional table formatting" },
      { name: "natbib", description: "Bibliography management" },
    ],
    content: `\\documentclass[12pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{graphicx}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}
\\usepackage{booktabs}
\\usepackage{natbib}
\\usepackage{lipsum}
\\usepackage{float}
\\usepackage{caption}
\\usepackage{subcaption}
\\usepackage{enumitem}
\\usepackage{microtype}

\\hypersetup{
  colorlinks=true,
  linkcolor=blue!70!black,
  citecolor=green!50!black,
  urlcolor=blue!80!black
}

\\newtheorem{theorem}{Theorem}[section]
\\newtheorem{lemma}[theorem]{Lemma}
\\newtheorem{definition}[theorem]{Definition}

\\title{\\textbf{Adaptive Neural Architecture Search\\\\via Gradient-Based Optimization}}
\\author{
  Alice M.\\\\ Johnson\\\\textsuperscript{1} \\\\and
  Robert K.\\\\ Chen\\\\textsuperscript{2} \\\\and
  Maria L.\\\\ Santos\\\\textsuperscript{1}\\\\\\\\
  \\\\textsuperscript{1}Department of Computer Science, Stanford University\\\\\\\\
  \\\\textsuperscript{2}Google DeepMind\\\\\\\\
  \\\\texttt{\\\\{ajohnson, msantos\\\\}@cs.stanford.edu, rchen@deepmind.com}
}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Neural Architecture Search (NAS) has emerged as a powerful paradigm for automating the design of deep neural networks. However, existing approaches often suffer from prohibitive computational costs and limited generalization across tasks. In this paper, we propose \\\\textit{AdaptiveNAS}, a novel gradient-based framework that leverages differentiable architecture parameters combined with a hierarchical search space to efficiently discover high-performing architectures. Our method introduces a multi-objective optimization criterion that simultaneously considers accuracy, latency, and model size. Extensive experiments on CIFAR-10, CIFAR-100, and ImageNet demonstrate that AdaptiveNAS achieves state-of-the-art performance while reducing search costs by $4.7\\\\times$ compared to previous methods. We further show that architectures discovered by our method transfer effectively to downstream tasks including object detection and semantic segmentation.
\\end{abstract}

\\section{Introduction}

Deep neural networks have achieved remarkable success across a wide range of applications, from image classification~\\\\citep{he2016deep} to natural language processing~\\\\citep{vaswani2017attention}. However, the design of neural network architectures remains a labor-intensive process that requires significant domain expertise. Neural Architecture Search (NAS) aims to automate this process by searching over a space of possible architectures to find those that maximize performance on a given task.

Early NAS methods relied on reinforcement learning~\\\\citep{zoph2017neural} or evolutionary algorithms~\\\\citep{real2019regularized} to explore the architecture space. While these approaches demonstrated the potential of automated architecture design, they required thousands of GPU hours to complete a single search, making them impractical for many applications. Recent work has focused on reducing the computational cost of NAS through weight sharing~\\\\citep{pham2018efficient} and differentiable relaxation~\\\\citep{liu2019darts}.

In this paper, we propose AdaptiveNAS, a novel gradient-based architecture search framework that addresses two key limitations of existing methods:

\\begin{enumerate}[label=(\\roman*)]
  \\item \\textbf{Search efficiency}: Our method uses a hierarchical search space that decomposes the architecture design problem into manageable sub-problems, enabling efficient gradient-based optimization.
  \\item \\textbf{Multi-objective optimization}: We introduce a differentiable surrogate for hardware-aware metrics, allowing simultaneous optimization of accuracy, latency, and model size.
\\end{enumerate}

Our main contributions are summarized as follows:
\\begin{itemize}
  \\item We propose a hierarchical differentiable search space that captures both cell-level and network-level architectural decisions.
  \\item We develop a novel multi-objective optimization strategy that balances accuracy with computational efficiency.
  \\item We achieve state-of-the-art results on CIFAR-10 (97.8\\\\%), CIFAR-100 (85.3\\\\%), and ImageNet (79.2\\\\% top-1) with significantly reduced search costs.
\\end{itemize}

\\section{Related Work}

\\subsection{Neural Architecture Search}

The field of NAS has evolved rapidly since the seminal work of Zoph and Le~\\\\citep{zoph2017neural}, who used a recurrent neural network controller trained with reinforcement learning to generate architecture descriptions. Subsequent work by Real et al.~\\\\citep{real2019regularized} demonstrated that evolutionary methods could achieve comparable results with improved stability.

\\subsection{Differentiable Architecture Search}

DARTS~\\\\citep{liu2019darts} introduced a continuous relaxation of the discrete architecture space, enabling gradient-based optimization. This approach reduced search costs from thousands of GPU hours to a single GPU day. However, DARTS is known to suffer from performance collapse, where the search converges to architectures dominated by skip connections.

\\subsection{Hardware-Aware NAS}

Several recent works have incorporated hardware constraints directly into the search process. MnasNet~\\\\citep{tan2019mnasnet} used a multi-objective reward function that balances accuracy and latency. FBNet~\\\\citep{wu2019fbnet} extended differentiable search to include latency-aware optimization through a lookup table approach.

\\section{Method}

\\subsection{Problem Formulation}

Let $\\\\mathcal{A}$ denote the space of all possible architectures. Our goal is to find an architecture $a^* \\\\in \\\\mathcal{A}$ that minimizes a multi-objective loss function:

\\begin{equation}
  a^* = \\\\arg\\\\min_{a \\\\in \\\\mathcal{A}} \\\\; \\\\mathcal{L}_{\\\\text{val}}(w^*(a), a) + \\\\lambda_1 \\\\cdot \\\\text{LAT}(a) + \\\\lambda_2 \\\\cdot \\\\text{SIZE}(a)
\\end{equation}

where $w^*(a) = \\\\arg\\\\min_w \\\\mathcal{L}_{\\\\text{train}}(w, a)$ are the optimal weights for architecture $a$, $\\\\text{LAT}(a)$ is the inference latency, and $\\\\text{SIZE}(a)$ is the number of parameters.

\\subsection{Hierarchical Search Space}

We decompose the search space into two levels. At the \\\\textit{cell level}, we search for computational cells that serve as building blocks. At the \\\\textit{network level}, we determine the arrangement and connectivity of these cells.

\\begin{definition}[Computational Cell]
A computational cell is a directed acyclic graph (DAG) $G = (V, E)$ where each node $v_i \\\\in V$ represents a latent feature map and each edge $(i, j) \\\\in E$ is associated with an operation $o_{ij} \\\\in \\\\mathcal{O}$.
\\end{definition}

The set of candidate operations $\\\\mathcal{O}$ includes:
\\begin{itemize}
  \\item $3 \\\\times 3$ and $5 \\\\times 5$ separable convolutions
  \\item $3 \\\\times 3$ and $5 \\\\times 5$ dilated separable convolutions
  \\item $3 \\\\times 3$ max pooling and average pooling
  \\item Identity (skip connection)
  \\item Zero (no connection)
\\end{itemize}

\\subsection{Differentiable Relaxation}

Following DARTS, we relax the categorical choice of operations to a continuous distribution using a softmax over architecture parameters $\\\\alpha$:

\\begin{equation}
  \\\\bar{o}_{ij}(x) = \\\\sum_{o \\\\in \\\\mathcal{O}} \\\\frac{\\\\exp(\\\\alpha_o^{ij})}{\\\\sum_{o' \\\\in \\\\mathcal{O}} \\\\exp(\\\\alpha_{o'}^{ij})} \\\\cdot o(x)
\\end{equation}

\\begin{theorem}[Convergence Guarantee]
Under mild regularity conditions on $\\\\mathcal{L}_{\\\\text{val}}$ and $\\\\mathcal{L}_{\\\\text{train}}$, the bilevel optimization converges to a stationary point at a rate of $O(1/\\\\sqrt{T})$ where $T$ is the number of iterations.
\\end{theorem}

\\section{Experiments}

\\subsection{Experimental Setup}

We evaluate AdaptiveNAS on three benchmark datasets: CIFAR-10, CIFAR-100, and ImageNet. For the search phase, we use a proxy task on CIFAR-10 with 8 cells and 16 initial channels. The search is conducted for 50 epochs using SGD with momentum 0.9 and weight decay $3 \\\\times 10^{-4}$.

\\subsection{Results on CIFAR-10 and CIFAR-100}

Table~\\\\ref{tab:cifar_results} summarizes the comparison with state-of-the-art methods on CIFAR-10 and CIFAR-100.

\\begin{table}[H]
\\centering
\\caption{Comparison of architectures on CIFAR-10 and CIFAR-100.}
\\label{tab:cifar_results}
\\begin{tabular}{@{}lccccc@{}}
\\toprule
\\textbf{Method} & \\textbf{CIFAR-10} & \\textbf{CIFAR-100} & \\textbf{Params} & \\textbf{Search Cost} & \\textbf{Search}\\\\\\\\
 & \\textbf{Error (\\\\%)} & \\textbf{Error (\\\\%)} & \\textbf{(M)} & \\textbf{(GPU days)} & \\textbf{Method} \\\\\\\\
\\midrule
NASNet-A        & 2.65 & 17.81 & 3.3 & 1800 & RL \\\\\\\\
AmoebaNet-A     & 2.55 & 18.93 & 3.2 & 3150 & Evolution \\\\\\\\
ENAS            & 2.89 & 19.43 & 4.6 & 0.5  & RL \\\\\\\\
DARTS (2nd)     & 2.76 & 17.54 & 3.3 & 1.0  & Gradient \\\\\\\\
PC-DARTS        & 2.57 & 17.11 & 3.6 & 0.1  & Gradient \\\\\\\\
\\midrule
\\textbf{AdaptiveNAS} & \\textbf{2.21} & \\textbf{14.72} & \\textbf{3.4} & \\textbf{0.2} & \\textbf{Gradient} \\\\\\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\subsection{Results on ImageNet}

We transfer the best cell architecture discovered on CIFAR-10 to ImageNet by constructing a larger network with 14 cells and 48 initial channels. As shown in Table~\\\\ref{tab:imagenet_results}, AdaptiveNAS achieves competitive top-1 accuracy while maintaining reasonable model complexity.

\\begin{table}[H]
\\centering
\\caption{ImageNet classification results.}
\\label{tab:imagenet_results}
\\begin{tabular}{@{}lcccc@{}}
\\toprule
\\textbf{Method} & \\textbf{Top-1 (\\\\%)} & \\textbf{Top-5 (\\\\%)} & \\textbf{Params (M)} & \\textbf{FLOPs (M)} \\\\\\\\
\\midrule
MobileNetV2    & 72.0 & 91.0 & 3.4 & 300 \\\\\\\\
NASNet-A       & 74.0 & 91.6 & 5.3 & 564 \\\\\\\\
DARTS          & 73.3 & 91.3 & 4.7 & 574 \\\\\\\\
ProxylessNAS   & 75.1 & 92.5 & 7.1 & 465 \\\\\\\\
\\midrule
\\textbf{AdaptiveNAS} & \\textbf{79.2} & \\textbf{94.5} & \\textbf{5.8} & \\textbf{490} \\\\\\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\section{Analysis}

\\subsection{Ablation Study}

To understand the contribution of each component, we conduct ablation experiments on CIFAR-10. Removing the hierarchical search space increases the error rate from 2.21\\\\% to 2.58\\\\%. Removing the multi-objective loss leads to architectures with 2.3$\\\\times$ more parameters while providing only marginal accuracy improvements. These results confirm that both components are essential for achieving the best accuracy-efficiency trade-off.

\\subsection{Search Cost Analysis}

Our method completes the architecture search in approximately 4.8 GPU hours on a single NVIDIA V100, which is $4.7\\\\times$ faster than DARTS and orders of magnitude faster than RL-based or evolutionary methods. The efficiency gain primarily comes from the hierarchical decomposition, which reduces the number of architecture parameters by 60\\\\%.

\\section{Conclusion}

We presented AdaptiveNAS, a gradient-based neural architecture search framework that achieves state-of-the-art results across multiple benchmarks while significantly reducing search costs. Our hierarchical search space and multi-objective optimization strategy enable the discovery of architectures that are both accurate and efficient. Future work will explore extending AdaptiveNAS to additional domains such as natural language processing and speech recognition, as well as incorporating additional hardware targets.

\\section*{Acknowledgments}

This work was supported in part by NSF Grant IIS-2024000 and a Google Faculty Research Award.

\\bibliographystyle{plainnat}
% \\\\bibliography{references}

\\begin{thebibliography}{10}

\\bibitem[He et~al.(2016)]{he2016deep}
Kaiming He, Xiangyu Zhang, Shaoqing Ren, and Jian Sun.
\\newblock Deep residual learning for image recognition.
\\newblock In \\textit{CVPR}, pages 770--778, 2016.

\\bibitem[Liu et~al.(2019)]{liu2019darts}
Hanxiao Liu, Karen Simonyan, and Yiming Yang.
\\newblock {DARTS}: Differentiable architecture search.
\\newblock In \\textit{ICLR}, 2019.

\\bibitem[Pham et~al.(2018)]{pham2018efficient}
Hieu Pham, Melody Guan, Barret Zoph, Quoc Le, and Jeff Dean.
\\newblock Efficient neural architecture search via parameter sharing.
\\newblock In \\textit{ICML}, pages 4095--4104, 2018.

\\bibitem[Real et~al.(2019)]{real2019regularized}
Esteban Real, Alok Aggarwal, Yanping Huang, and Quoc~V Le.
\\newblock Regularized evolution for image classifier architecture search.
\\newblock In \\textit{AAAI}, volume~33, pages 4780--4789, 2019.

\\bibitem[Tan et~al.(2019)]{tan2019mnasnet}
Mingxing Tan, Bo~Chen, Ruoming Pang, Vijay Vasudevan, Mark Sandler, Andrew Howard, and Quoc~V Le.
\\newblock {MnasNet}: Platform-aware neural architecture search for mobile.
\\newblock In \\textit{CVPR}, pages 2820--2828, 2019.

\\bibitem[Vaswani et~al.(2017)]{vaswani2017attention}
Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan~N Gomez, Lukasz Kaiser, and Illia Polosukhin.
\\newblock Attention is all you need.
\\newblock In \\textit{NeurIPS}, pages 5998--6008, 2017.

\\bibitem[Wu et~al.(2019)]{wu2019fbnet}
Bichen Wu, Xiaoliang Dai, Peizhao Zhang, Yanghan Wang, Fei Sun, Yiming Wu, Yuandong Tian, Peter Vajda, Yangqing Jia, and Kurt Keutzer.
\\newblock {FBNet}: Hardware-aware efficient convnet design via differentiable neural architecture search.
\\newblock In \\textit{CVPR}, pages 10734--10742, 2019.

\\bibitem[Zoph and Le(2017)]{zoph2017neural}
Barret Zoph and Quoc~V Le.
\\newblock Neural architecture search with reinforcement learning.
\\newblock In \\textit{ICLR}, 2017.

\\end{thebibliography}

\\end{document}
`,
  },
  {
    id: "paper-ieee",
    name: "IEEE Conference Paper",
    description: "Two-column IEEE conference format with standard sections",
    category: "academic",
    subcategory: "papers",
    tags: [
      "ieee",
      "conference",
      "two-column",
      "engineering",
      "computer science",
    ],
    icon: "FileText",
    documentClass: "IEEEtran",
    mainFileName: "main.tex",
    accentColor: "#2563eb",
    hasBibliography: true,
    aspectRatio: "3/4",
    packages: [
      { name: "amsmath", description: "AMS mathematical typesetting" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
      { name: "cite", description: "Citation sorting and compression" },
      { name: "algorithmic", description: "Algorithm typesetting" },
    ],
    content: `\\documentclass[conference]{IEEEtran}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{cite}
\\usepackage{booktabs}
\\usepackage{algorithmic}
\\usepackage{algorithm}
\\usepackage{microtype}
\\usepackage{xcolor}
\\usepackage{lipsum}

\\title{FedSecure: A Privacy-Preserving Federated Learning Framework for Heterogeneous Edge Networks}
\\author{
  \\IEEEauthorblockN{James R. Mitchell\\IEEEauthorrefmark{1}, Sarah K. Park\\IEEEauthorrefmark{2}, and David L. Fernandez\\IEEEauthorrefmark{1}}
  \\IEEEauthorblockA{\\IEEEauthorrefmark{1}Department of Electrical and Computer Engineering\\\\
  Georgia Institute of Technology, Atlanta, GA 30332\\\\
  Email: \\{jmitchell, dfernandez\\}@gatech.edu}
  \\IEEEauthorblockA{\\IEEEauthorrefmark{2}Microsoft Research\\\\
  Redmond, WA 98052\\\\
  Email: sarahpark@microsoft.com}
}

\\begin{document}

\\maketitle

\\begin{abstract}
Federated learning enables collaborative model training across distributed edge devices without centralizing raw data. However, existing frameworks face critical challenges in handling statistical heterogeneity across clients and ensuring robust privacy guarantees. In this paper, we present FedSecure, a novel federated learning framework that integrates differential privacy with adaptive aggregation strategies designed for heterogeneous edge networks. Our approach introduces a client-aware noise calibration mechanism that adjusts privacy budgets based on local data characteristics, achieving a favorable privacy-utility trade-off. We propose a hierarchical aggregation protocol that groups clients by data distribution similarity, reducing the impact of non-IID data on global model convergence. Extensive experiments on four benchmark datasets across diverse heterogeneity scenarios demonstrate that FedSecure improves accuracy by 8.3\\% over FedAvg while maintaining $(\\epsilon, \\delta)$-differential privacy with $\\epsilon = 1.0$. Our framework also reduces communication overhead by 40\\% through gradient compression and selective participation.
\\end{abstract}

\\begin{IEEEkeywords}
Federated learning, differential privacy, edge computing, heterogeneous networks, distributed machine learning
\\end{IEEEkeywords}

\\section{Introduction}

The proliferation of edge devices has created unprecedented opportunities for distributed machine learning. Mobile phones, IoT sensors, and autonomous vehicles generate vast amounts of data that can be leveraged to train powerful predictive models. However, transmitting this data to a central server raises significant privacy concerns and may violate data protection regulations such as GDPR and CCPA~\\cite{voigt2017gdpr}.

Federated learning (FL) has emerged as a promising paradigm to address these challenges by enabling model training directly on edge devices~\\cite{mcmahan2017communication}. In the canonical federated learning setup, a central server coordinates the training process by distributing model parameters to participating clients, which perform local training on their private data and return model updates to the server for aggregation.

Despite significant progress, two fundamental challenges remain:

\\begin{enumerate}
\\item \\textbf{Statistical heterogeneity}: Data distributions across clients are typically non-IID, leading to client drift and degraded global model performance~\\cite{karimireddy2020scaffold}.
\\item \\textbf{Privacy guarantees}: While federated learning avoids direct data sharing, model updates can still leak sensitive information through inference attacks~\\cite{nasr2019comprehensive}.
\\end{enumerate}

In this paper, we propose FedSecure, a comprehensive framework that jointly addresses these challenges. Our key contributions include:

\\begin{itemize}
\\item A client-aware differential privacy mechanism that adaptively calibrates noise injection based on local data characteristics and sensitivity.
\\item A hierarchical aggregation protocol that clusters clients by distribution similarity to mitigate non-IID effects.
\\item A gradient compression scheme that reduces communication costs while preserving model quality under privacy constraints.
\\item Comprehensive evaluation on CIFAR-10, CIFAR-100, FEMNIST, and Shakespeare datasets demonstrating state-of-the-art performance.
\\end{itemize}

\\section{Related Work}

\\subsection{Federated Learning}

McMahan et al.~\\cite{mcmahan2017communication} introduced FedAvg, the foundational algorithm for federated learning. Subsequent work has proposed improvements for handling non-IID data, including FedProx~\\cite{li2020federated}, SCAFFOLD~\\cite{karimireddy2020scaffold}, and FedNova~\\cite{wang2020tackling}. These methods introduce regularization terms or variance reduction techniques to improve convergence under heterogeneous data distributions.

\\subsection{Differential Privacy in FL}

Differential privacy (DP) provides formal privacy guarantees by adding calibrated noise to computations~\\cite{dwork2014algorithmic}. Several works have integrated DP into federated learning, including user-level DP~\\cite{mcmahan2018learning} and record-level DP approaches. The primary challenge lies in balancing the privacy budget with model utility, particularly in heterogeneous settings.

\\section{Proposed Framework}

\\subsection{System Model}

We consider a federated learning system with $N$ clients $\\{C_1, C_2, \\ldots, C_N\\}$ coordinated by a central server $S$. Each client $C_i$ holds a local dataset $\\mathcal{D}_i$ of size $n_i$, drawn from a potentially unique distribution $P_i$. The global objective is:

\\begin{equation}
\\min_{w} F(w) = \\sum_{i=1}^{N} \\frac{n_i}{n} F_i(w)
\\end{equation}

where $F_i(w) = \\mathbb{E}_{\\xi \\sim P_i}[f(w; \\xi)]$ is the local objective and $n = \\sum_{i=1}^{N} n_i$.

\\subsection{Client-Aware Noise Calibration}

Standard DP mechanisms apply uniform noise across all clients, which is suboptimal when clients have varying data characteristics. We propose an adaptive noise calibration strategy that adjusts the noise scale $\\sigma_i$ for each client:

\\begin{equation}
\\sigma_i = \\frac{\\Delta_i \\cdot \\sqrt{2 \\ln(1.25/\\delta)}}{\\epsilon_i}
\\end{equation}

where $\\Delta_i$ is the sensitivity of client $i$'s gradient update and $\\epsilon_i$ is the allocated privacy budget. We distribute the total privacy budget $\\epsilon$ across clients using an optimization-based allocation that minimizes the expected aggregation error.

\\subsection{Hierarchical Aggregation}

To address non-IID data, we introduce a two-level aggregation scheme. First, we compute the pairwise distribution distance between clients using the Wasserstein distance estimated from model updates. Clients are then clustered into $K$ groups $\\{G_1, \\ldots, G_K\\}$ using spectral clustering. Aggregation proceeds in two phases: intra-group aggregation followed by inter-group aggregation.

\\begin{algorithm}[t]
\\caption{FedSecure Training Protocol}
\\begin{algorithmic}[1]
\\STATE \\textbf{Input:} $N$ clients, rounds $T$, local epochs $E$, privacy budget $\\epsilon$
\\STATE Initialize global model $w_0$
\\FOR{$t = 0$ to $T-1$}
  \\STATE Server selects subset $S_t \\subseteq \\{1,\\ldots,N\\}$
  \\STATE Server broadcasts $w_t$ to selected clients
  \\FOR{each client $i \\in S_t$ \\textbf{in parallel}}
    \\STATE $g_i \\leftarrow$ LocalTrain($w_t, \\mathcal{D}_i, E$)
    \\STATE $\\hat{g}_i \\leftarrow$ Clip($g_i$, $C$) + $\\mathcal{N}(0, \\sigma_i^2 I)$
    \\STATE Send $\\hat{g}_i$ to server
  \\ENDFOR
  \\STATE Server clusters clients into groups $\\{G_k\\}$
  \\STATE $w_{t+1} \\leftarrow$ HierarchicalAggregate($\\{\\hat{g}_i\\}$, $\\{G_k\\}$)
\\ENDFOR
\\end{algorithmic}
\\end{algorithm}

\\section{Experimental Evaluation}

\\subsection{Setup}

We evaluate FedSecure on four datasets: CIFAR-10, CIFAR-100, FEMNIST (62-class character recognition), and Shakespeare (next-character prediction). We simulate non-IID distributions using a Dirichlet allocation with concentration parameter $\\alpha \\in \\{0.1, 0.5, 1.0\\}$ across 100 clients. We use ResNet-18 for CIFAR experiments and an LSTM model for Shakespeare.

\\subsection{Main Results}

Table~\\ref{tab:main_results} presents the comparison of FedSecure with baseline methods under non-IID settings ($\\alpha = 0.5$) with privacy guarantee $\\epsilon = 1.0$.

\\begin{table}[t]
\\centering
\\caption{Test accuracy (\\%) comparison under non-IID setting ($\\alpha=0.5$) with $\\epsilon=1.0$ differential privacy.}
\\label{tab:main_results}
\\begin{tabular}{@{}lcccc@{}}
\\toprule
\\textbf{Method} & \\textbf{CIFAR-10} & \\textbf{CIFAR-100} & \\textbf{FEMNIST} & \\textbf{Shakespeare} \\\\
\\midrule
FedAvg + DP     & 61.2 & 33.8 & 72.4 & 45.1 \\\\
FedProx + DP    & 63.5 & 35.2 & 74.1 & 46.8 \\\\
SCAFFOLD + DP   & 65.1 & 37.4 & 75.3 & 47.9 \\\\
DP-FedAvg       & 59.8 & 32.1 & 70.9 & 43.6 \\\\
\\midrule
\\textbf{FedSecure} & \\textbf{69.5} & \\textbf{41.7} & \\textbf{78.6} & \\textbf{51.2} \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\subsection{Communication Efficiency}

FedSecure achieves a 40\\% reduction in communication overhead compared to FedAvg through the combination of gradient compression and selective client participation. To reach 65\\% accuracy on CIFAR-10 with $\\epsilon = 1.0$, FedSecure requires 120 communication rounds compared to 280 for FedAvg + DP and 195 for SCAFFOLD + DP.

\\subsection{Privacy-Utility Trade-off}

We analyze the privacy-utility trade-off by varying $\\epsilon$ from 0.1 to 10.0. FedSecure consistently outperforms baselines across all privacy levels. At stringent privacy ($\\epsilon = 0.1$), FedSecure achieves 52.3\\% accuracy on CIFAR-10 compared to 41.7\\% for the best baseline, demonstrating the effectiveness of client-aware noise calibration.

\\section{Conclusion}

We presented FedSecure, a privacy-preserving federated learning framework that addresses the dual challenges of statistical heterogeneity and privacy protection in edge networks. Through client-aware noise calibration and hierarchical aggregation, FedSecure achieves state-of-the-art performance across diverse datasets while providing formal differential privacy guarantees. Future work will explore extending FedSecure to cross-silo settings and incorporating secure aggregation protocols for enhanced protection against server-side attacks.

\\section*{Acknowledgment}

This work was supported by NSF grants CNS-2143868 and CNS-2106891, and by a gift from Microsoft Research.

\\begin{thebibliography}{10}

\\bibitem{mcmahan2017communication}
B.~McMahan, E.~Moore, D.~Ramage, S.~Hampson, and B.~Aguera y Arcas, \`\`Communication-efficient learning of deep networks from decentralized data,'' in \\textit{Proc. AISTATS}, pp.~1273--1282, 2017.

\\bibitem{voigt2017gdpr}
P.~Voigt and A.~Von dem Bussche, \`\`The {EU} general data protection regulation ({GDPR}),'' \\textit{Springer International Publishing}, vol.~10, pp.~10--5555, 2017.

\\bibitem{karimireddy2020scaffold}
S.~P. Karimireddy, S.~Kale, M.~Mohri, S.~Reddi, S.~Stich, and A.~T. Suresh, \`\`{SCAFFOLD}: Stochastic controlled averaging for federated learning,'' in \\textit{Proc. ICML}, pp.~5132--5143, 2020.

\\bibitem{nasr2019comprehensive}
M.~Nasr, R.~Shokri, and A.~Houmansadr, \`\`Comprehensive privacy analysis of deep learning,'' in \\textit{Proc. IEEE S\\&P}, pp.~739--753, 2019.

\\bibitem{li2020federated}
T.~Li, A.~K. Sahu, M.~Zaheer, M.~Sanjabi, A.~Talwalkar, and V.~Smith, \`\`Federated optimization in heterogeneous networks,'' in \\textit{Proc. MLSys}, 2020.

\\bibitem{wang2020tackling}
J.~Wang, Q.~Liu, H.~Liang, G.~Joshi, and H.~V. Poor, \`\`Tackling the objective inconsistency problem in heterogeneous federated optimization,'' in \\textit{Proc. NeurIPS}, vol.~33, pp.~7611--7623, 2020.

\\bibitem{dwork2014algorithmic}
C.~Dwork and A.~Roth, \`\`The algorithmic foundations of differential privacy,'' \\textit{Foundations and Trends in Theoretical Computer Science}, vol.~9, no.~3--4, pp.~211--407, 2014.

\\bibitem{mcmahan2018learning}
H.~B. McMahan, D.~Ramage, K.~Talwar, and L.~Zhang, \`\`Learning differentially private recurrent language models,'' in \\textit{Proc. ICLR}, 2018.

\\end{thebibliography}

\\end{document}
`,
  },
  {
    id: "paper-acm",
    name: "ACM Conference Paper",
    description: "ACM SIGCONF format for computing conferences",
    category: "academic",
    subcategory: "papers",
    tags: ["acm", "conference", "computing", "sigconf", "computer science"],
    icon: "FileText",
    documentClass: "acmart",
    mainFileName: "main.tex",
    accentColor: "#1d4ed8",
    hasBibliography: true,
    aspectRatio: "3/4",
    packages: [
      { name: "amsmath", description: "AMS mathematical typesetting" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "booktabs", description: "Professional table formatting" },
    ],
    content: `\\documentclass[sigconf,nonacm]{acmart}

\\usepackage{booktabs}
\\usepackage{lipsum}
\\usepackage{listings}
\\usepackage{xcolor}

\\lstset{
  basicstyle=\\ttfamily\\small,
  keywordstyle=\\color{blue!70!black}\\bfseries,
  commentstyle=\\color{green!50!black}\\itshape,
  stringstyle=\\color{red!60!black},
  frame=single,
  breaklines=true,
  numbers=left,
  numberstyle=\\tiny\\color{gray},
  tabsize=2
}

\\title{ConversaDB: A Context-Aware Query Engine for Conversational Database Interactions}

\\author{Emily R. Nakamura}
\\affiliation{
  \\institution{University of Washington}
  \\department{Paul G. Allen School of Computer Science}
  \\city{Seattle}
  \\state{WA}
  \\country{USA}
}
\\email{enakamura@cs.washington.edu}

\\author{Carlos A. Mendez}
\\affiliation{
  \\institution{ETH Zurich}
  \\department{Department of Computer Science}
  \\city{Zurich}
  \\country{Switzerland}
}
\\email{mendez@inf.ethz.ch}

\\author{Priya S. Gupta}
\\affiliation{
  \\institution{Microsoft Research}
  \\city{Redmond}
  \\state{WA}
  \\country{USA}
}
\\email{priyag@microsoft.com}

\\begin{document}

\\begin{abstract}
Natural language interfaces to databases (NLIDBs) have long been a goal of the database and NLP communities. While recent advances in large language models (LLMs) have dramatically improved text-to-SQL accuracy, existing systems treat each query independently, ignoring the conversational context that is natural in real-world database interactions. We present ConversaDB, a context-aware query engine that maintains a multi-turn dialogue state to resolve ambiguities, handle co-references, and support follow-up queries. Our system introduces three key innovations: (1)~a dialogue state tracker that maintains a structured representation of the conversation history, including referenced tables, columns, and filter conditions; (2)~a context-aware SQL generation module that conditions on both the current utterance and the dialogue state; and (3)~an interactive disambiguation protocol that proactively seeks clarification when query intent is uncertain. We evaluate ConversaDB on the SParC and CoSQL benchmarks, achieving 71.4\\% and 53.8\\% question match accuracy respectively, representing improvements of 6.2\\% and 8.1\\% over the previous state of the art. A user study with 48 participants confirms that ConversaDB significantly reduces the number of interaction turns required to complete complex analytical tasks.
\\end{abstract}

\\keywords{natural language interfaces, text-to-SQL, conversational AI, database systems, dialogue state tracking}

\\maketitle

\\section{Introduction}

Databases store vast amounts of structured information, yet accessing this data requires proficiency in query languages such as SQL. Natural language interfaces to databases (NLIDBs) aim to bridge this gap by allowing users to express their information needs in plain language. Recent progress in large language models has led to dramatic improvements in single-turn text-to-SQL systems, with state-of-the-art models achieving over 80\\% accuracy on the Spider benchmark~\\cite{yu2018spider}.

However, real-world database interactions are inherently conversational. Users rarely formulate their complete information need in a single query. Instead, they engage in multi-turn dialogues, refining their queries, asking follow-up questions, and exploring the data incrementally. Consider the following example interaction:

\\begin{enumerate}
\\item \\textit{\`\`Show me sales by region for Q4 2024.''}
\\item \\textit{\`\`What about the previous quarter?''}
\\item \\textit{\`\`Sort those by revenue.''}
\\item \\textit{\`\`Which region had the highest growth?''}
\\end{enumerate}

Each utterance after the first requires understanding the conversational context to generate the correct SQL query. Utterance~2 requires resolving \`\`the previous quarter'' relative to Q4~2024. Utterance~3 refers to \`\`those,'' which co-references the results from utterance~2. These phenomena---temporal references, co-references, and ellipsis---are pervasive in natural dialogue but poorly handled by single-turn systems.

\\paragraph{Contributions.} We make the following contributions:

\\begin{itemize}
\\item We introduce ConversaDB, a context-aware query engine that maintains structured dialogue state for multi-turn database interactions.
\\item We propose a novel context-aware SQL generation architecture that combines dialogue state tracking with constrained decoding.
\\item We design an interactive disambiguation protocol that reduces errors by proactively seeking clarification.
\\item We achieve new state-of-the-art results on SParC and CoSQL benchmarks and validate our system through a comprehensive user study.
\\end{itemize}

\\section{Related Work}

\\subsection{Text-to-SQL}

The text-to-SQL task has seen rapid progress in recent years. Early approaches used rule-based parsing and template filling~\\cite{li2014constructing}. Neural approaches, beginning with Seq2SQL~\\cite{zhong2017seq2sql}, framed the problem as sequence-to-sequence translation. More recent work leverages pre-trained language models, with systems like RESDSQL~\\cite{li2023resdsql} achieving over 80\\% exact match accuracy on Spider.

\\subsection{Conversational Text-to-SQL}

SParC~\\cite{yu2019sparc} and CoSQL~\\cite{yu2019cosql} introduced benchmarks for context-dependent text-to-SQL. EditSQL~\\cite{zhang2019editing} proposed editing the previous SQL query to handle follow-up questions. IGSQL~\\cite{cai2020igsql} used an interaction graph to capture cross-turn dependencies. Despite these advances, handling complex co-references and temporal expressions remains challenging.

\\section{System Architecture}

ConversaDB consists of three main components: (1)~a Dialogue State Tracker (DST), (2)~a Context-Aware SQL Generator (CASG), and (3)~an Interactive Disambiguation Module (IDM). Figure~1 illustrates the overall architecture.

\\subsection{Dialogue State Tracker}

The DST maintains a structured representation $\\mathcal{S}_t$ at each turn $t$ that captures the essential context from the conversation history:

\\begin{equation}
\\mathcal{S}_t = (\\mathcal{T}_t, \\mathcal{C}_t, \\mathcal{F}_t, \\mathcal{R}_t, Q_{t-1})
\\end{equation}

\\noindent where $\\mathcal{T}_t$ is the set of referenced tables, $\\mathcal{C}_t$ is the set of referenced columns, $\\mathcal{F}_t$ represents active filter conditions, $\\mathcal{R}_t$ captures the result schema from the previous query, and $Q_{t-1}$ is the most recent SQL query. At each turn, the DST updates the state based on the new utterance $u_t$:

\\begin{equation}
\\mathcal{S}_t = \\text{DST}(\\mathcal{S}_{t-1}, u_t, \\mathcal{DB})
\\end{equation}

\\noindent where $\\mathcal{DB}$ denotes the database schema.

\\subsection{Context-Aware SQL Generator}

The CASG generates SQL queries conditioned on both the current utterance and the dialogue state. We encode the input as a linearized sequence:

\\begin{equation}
x_t = [u_t; \\text{serialize}(\\mathcal{S}_t); \\text{serialize}(\\mathcal{DB})]
\\end{equation}

The SQL query is generated autoregressively with schema-aware constrained decoding that ensures syntactic validity. We fine-tune a pre-trained T5-large model with the following objective:

\\begin{equation}
\\mathcal{L} = -\\sum_{t=1}^{T} \\sum_{j=1}^{|q_t|} \\log P(q_t^j \\mid q_t^{<j}, x_t; \\theta)
\\end{equation}

\\subsection{Interactive Disambiguation}

When the model's confidence in the generated SQL falls below threshold $\\tau$, the IDM generates a clarification question. We compute confidence as the geometric mean of token-level probabilities:

\\begin{equation}
\\text{conf}(q_t) = \\left( \\prod_{j=1}^{|q_t|} P(q_t^j \\mid q_t^{<j}, x_t) \\right)^{1/|q_t|}
\\end{equation}

\\section{Evaluation}

\\subsection{Benchmark Results}

Table~\\ref{tab:benchmark} shows results on SParC and CoSQL.

\\begin{table}[t]
\\caption{Question match accuracy (\\%) on SParC and CoSQL development sets.}
\\label{tab:benchmark}
\\begin{tabular}{@{}lcc@{}}
\\toprule
\\textbf{Model} & \\textbf{SParC} & \\textbf{CoSQL} \\\\
\\midrule
EditSQL (2019)           & 47.2 & 31.4 \\\\
IGSQL (2020)             & 50.7 & 36.8 \\\\
HIE-SQL (2022)           & 60.1 & 42.3 \\\\
STAR (2023)              & 65.2 & 45.7 \\\\
\\midrule
\\textbf{ConversaDB}      & \\textbf{71.4} & \\textbf{53.8} \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\subsection{User Study}

We conducted a user study with 48 participants (24 SQL-proficient, 24 non-technical) who completed 8 analytical tasks using ConversaDB and a single-turn baseline. ConversaDB reduced the average number of interaction turns from 6.3 to 3.8 and increased task completion rate from 72\\% to 91\\%. Participants rated ConversaDB 4.2/5.0 on naturalness compared to 2.8/5.0 for the baseline.

\\subsection{Ablation Study}

Table~\\ref{tab:ablation} shows the contribution of each component.

\\begin{table}[t]
\\caption{Ablation study on SParC development set.}
\\label{tab:ablation}
\\begin{tabular}{@{}lc@{}}
\\toprule
\\textbf{Configuration} & \\textbf{QM Acc. (\\%)} \\\\
\\midrule
Full ConversaDB                    & 71.4 \\\\
$-$ Dialogue State Tracker         & 63.8 \\\\
$-$ Constrained Decoding           & 67.1 \\\\
$-$ Interactive Disambiguation     & 69.2 \\\\
$-$ Pre-training                   & 58.4 \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\section{Conclusion}

We presented ConversaDB, a context-aware query engine that brings conversational capabilities to natural language database interfaces. By maintaining structured dialogue state and employing context-aware SQL generation with interactive disambiguation, ConversaDB achieves state-of-the-art results on multi-turn text-to-SQL benchmarks. Our user study confirms that the conversational paradigm significantly improves the database interaction experience for both technical and non-technical users.

\\section*{Acknowledgments}

This research was supported by NSF Award IIS-2238811 and a gift from Microsoft Research. We thank the anonymous reviewers for their constructive feedback.

\\bibliographystyle{ACM-Reference-Format}
% \\bibliography{references}

\\begin{thebibliography}{10}

\\bibitem{yu2018spider}
T.~Yu et~al., \`\`Spider: A large-scale human-labeled dataset for complex and cross-database semantic parsing and text-to-SQL task,'' in \\textit{EMNLP}, 2018, pp.~3911--3921.

\\bibitem{li2014constructing}
F.~Li and H.~V. Jagadish, \`\`Constructing an interactive natural language interface for relational databases,'' \\textit{PVLDB}, vol.~8, no.~1, pp.~73--84, 2014.

\\bibitem{zhong2017seq2sql}
V.~Zhong, C.~Xiong, and R.~Socher, \`\`Seq2SQL: Generating structured queries from natural language using reinforcement learning,'' \\textit{arXiv:1709.00103}, 2017.

\\bibitem{li2023resdsql}
H.~Li et~al., \`\`RESDSQL: Decoupling schema linking and skeleton parsing for text-to-SQL,'' in \\textit{AAAI}, 2023.

\\bibitem{yu2019sparc}
T.~Yu et~al., \`\`SParC: Cross-domain semantic parsing in context,'' in \\textit{ACL}, 2019, pp.~4511--4523.

\\bibitem{yu2019cosql}
T.~Yu et~al., \`\`CoSQL: A conversational text-to-SQL challenge towards cross-domain natural language interfaces to databases,'' in \\textit{EMNLP}, 2019.

\\bibitem{zhang2019editing}
R.~Zhang et~al., \`\`Editing-based SQL query generation for cross-domain context-dependent questions,'' in \\textit{EMNLP}, 2019.

\\bibitem{cai2020igsql}
Y.~Cai and B.~Wan, \`\`IGSQL: Database schema interaction graph based neural model for context-dependent text-to-SQL generation,'' in \\textit{EMNLP}, 2020.

\\end{thebibliography}

\\end{document}
`,
  },
  {
    id: "thesis-standard",
    name: "Thesis",
    description: "Dissertation or thesis with chapters and front matter",
    category: "academic",
    subcategory: "theses",
    tags: ["thesis", "dissertation", "phd", "masters", "chapters", "academic"],
    icon: "GraduationCap",
    documentClass: "report",
    mainFileName: "main.tex",
    accentColor: "#8b5cf6",
    hasBibliography: true,
    aspectRatio: "3/4",
    packages: [
      { name: "amsmath", description: "AMS mathematical typesetting" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "geometry", description: "Page layout customization" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
      { name: "booktabs", description: "Professional table formatting" },
      { name: "natbib", description: "Bibliography management" },
      { name: "setspace", description: "Line spacing control" },
    ],
    content: `\\documentclass[12pt,a4paper,oneside]{report}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{graphicx}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}
\\usepackage{booktabs}
\\usepackage{natbib}
\\usepackage{setspace}
\\usepackage{fancyhdr}
\\usepackage{titlesec}
\\usepackage{lipsum}
\\usepackage{enumitem}
\\usepackage{microtype}
\\usepackage{xcolor}

\\hypersetup{
  colorlinks=true,
  linkcolor=blue!60!black,
  citecolor=green!50!black,
  urlcolor=blue!70!black
}

% Chapter heading style
\\titleformat{\\chapter}[display]
  {\\normalfont\\huge\\bfseries}{\\chaptertitlename\\\\ \\thechapter}{18pt}{\\Huge}
\\titlespacing*{\\chapter}{0pt}{-20pt}{30pt}

% Header/footer
\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[L]{\\slshape\\nouppercase{\\leftmark}}
\\fancyhead[R]{\\thepage}
\\renewcommand{\\headrulewidth}{0.4pt}

\\onehalfspacing

\\newtheorem{theorem}{Theorem}[chapter]
\\newtheorem{definition}[theorem]{Definition}
\\newtheorem{proposition}[theorem]{Proposition}

\\begin{document}

% ──── Title Page ────
\\begin{titlepage}
\\centering
\\vspace*{1.5cm}
{\\Large University of Cambridge\\\\[0.3cm]}
{\\large Faculty of Mathematics\\\\Department of Applied Mathematics and Theoretical Physics\\\\[2cm]}
{\\Huge\\bfseries Spectral Methods for\\\\Nonlinear Partial Differential Equations\\\\with Applications to Fluid Dynamics\\\\[1.5cm]}
{\\Large A thesis submitted for the degree of\\\\Doctor of Philosophy\\\\[2cm]}
{\\Large\\textbf{Alexandra M. Richardson}\\\\[0.5cm]}
{\\large Churchill College\\\\[1cm]}
{\\large September 2025}
\\vfill
\\end{titlepage}

% ──── Declaration ────
\\chapter*{Declaration}
\\addcontentsline{toc}{chapter}{Declaration}

This thesis is the result of my own work and includes nothing which is the outcome of work done in collaboration except as declared in the preface and specified in the text. It is not substantially the same as any work that has already been submitted before for any degree or other qualification except as declared in the preface and specified in the text.

This thesis does not exceed the prescribed word limit of 60,000 words set by the Degree Committee for the Faculty of Mathematics.

\\vspace{2cm}
\\noindent\\textit{Alexandra M. Richardson}\\\\
Cambridge, September 2025

% ──── Abstract ────
\\chapter*{Abstract}
\\addcontentsline{toc}{chapter}{Abstract}

This thesis develops novel spectral methods for the numerical solution of nonlinear partial differential equations (PDEs) arising in fluid dynamics. We focus on three interrelated topics: high-order spectral element methods for the incompressible Navier--Stokes equations, adaptive spectral methods for singularly perturbed problems, and spectral collocation methods for free-boundary problems.

In the first part, we introduce a new stabilized spectral element formulation for the Navier--Stokes equations that maintains exponential convergence while avoiding spurious pressure modes. We prove stability and convergence estimates for the fully discrete scheme and demonstrate its effectiveness on benchmark problems including lid-driven cavity flow and flow past a cylinder.

In the second part, we develop an adaptive spectral method that automatically adjusts the polynomial degree and element size to resolve boundary layers in singularly perturbed convection-diffusion equations. We derive \\textit{a posteriori} error estimates in the energy norm that drive the adaptation strategy.

In the third part, we apply spectral collocation methods to Stefan-type free-boundary problems arising in solidification and melting processes. We formulate the free-boundary condition as a nonlinear equation coupled with the bulk PDE and develop an efficient iterative solver based on Newton's method with spectral discretization.

Numerical experiments throughout the thesis confirm the theoretical convergence rates and demonstrate the practical effectiveness of the proposed methods on physically relevant problems.

% ──── Acknowledgements ────
\\chapter*{Acknowledgements}
\\addcontentsline{toc}{chapter}{Acknowledgements}

I am deeply grateful to my supervisor, Professor James H. Thornton, for his unwavering guidance, patience, and encouragement throughout my doctoral studies. His insights into numerical analysis and fluid dynamics have been invaluable, and his mentorship has shaped my development as a researcher.

I would like to thank Dr. Sophie Chen and Dr. Marcus Weber for many stimulating discussions and for their collaboration on the work presented in Chapter~4. I am also grateful to the members of the Applied Mathematics group at DAMTP for creating an intellectually vibrant and supportive environment.

This work was supported by a Gates Cambridge Scholarship and by EPSRC Grant EP/R014604/1. Computing resources were provided by the Cambridge Service for Data Driven Discovery (CSD3).

Finally, I thank my family and friends for their love and support throughout this journey.

% ──── Table of Contents ────
\\tableofcontents
\\listoffigures
\\listoftables

% ──── Main Matter ────

\\chapter{Introduction}
\\label{ch:introduction}

\\section{Motivation}

The numerical simulation of fluid flows is one of the most important and challenging problems in computational science and engineering. From weather prediction and climate modeling to the design of aircraft and biomedical devices, accurate and efficient numerical methods for fluid dynamics are essential tools in modern science and technology.

The governing equations for incompressible viscous flow are the Navier--Stokes equations:
\\begin{align}
  \\frac{\\partial \\mathbf{u}}{\\partial t} + (\\mathbf{u} \\cdot \\nabla)\\mathbf{u} &= -\\nabla p + \\frac{1}{\\text{Re}} \\nabla^2 \\mathbf{u} + \\mathbf{f}, \\label{eq:ns_momentum} \\\\
  \\nabla \\cdot \\mathbf{u} &= 0, \\label{eq:ns_continuity}
\\end{align}
where $\\mathbf{u}$ is the velocity field, $p$ is the pressure, $\\text{Re}$ is the Reynolds number, and $\\mathbf{f}$ represents body forces. Despite their apparent simplicity, these equations exhibit an extraordinary range of complex phenomena, from laminar boundary layers to turbulent cascades spanning multiple scales.

\\section{Spectral Methods: An Overview}

Spectral methods approximate the solution of a PDE as a finite sum of basis functions, typically orthogonal polynomials or trigonometric functions. For a function $u(x)$ on the interval $[-1, 1]$, the spectral approximation takes the form:
\\begin{equation}
  u_N(x) = \\sum_{k=0}^{N} \\hat{u}_k \\phi_k(x)
\\end{equation}
where $\\{\\phi_k\\}$ are the basis functions and $\\{\\hat{u}_k\\}$ are the expansion coefficients. The hallmark of spectral methods is their \\textit{spectral} (exponential) convergence rate for smooth problems: if $u$ is analytic, then the approximation error decreases exponentially with $N$.

\\begin{theorem}[Spectral Convergence]
Let $u \\in H^s([-1,1])$ for some $s \\geq 0$, and let $u_N$ be its best polynomial approximation of degree $N$. Then:
\\begin{equation}
  \\|u - u_N\\|_{L^2} \\leq C N^{-s} \\|u\\|_{H^s}
\\end{equation}
Moreover, if $u$ is analytic in an ellipse $\\mathcal{E}_\\rho$ with parameter $\\rho > 1$, then:
\\begin{equation}
  \\|u - u_N\\|_{L^2} \\leq C \\rho^{-N} \\max_{z \\in \\mathcal{E}_\\rho} |u(z)|
\\end{equation}
\\end{theorem}

\\section{Thesis Outline}

The remainder of this thesis is organized as follows:
\\begin{description}
  \\item[Chapter 2] reviews the mathematical foundations of spectral methods, including polynomial interpolation, quadrature rules, and the spectral element method.
  \\item[Chapter 3] presents our stabilized spectral element formulation for the Navier--Stokes equations.
  \\item[Chapter 4] develops adaptive spectral methods for singularly perturbed problems.
  \\item[Chapter 5] applies spectral collocation to free-boundary problems.
  \\item[Chapter 6] summarizes our contributions and discusses future research directions.
\\end{description}

\\chapter{Mathematical Foundations}
\\label{ch:foundations}

\\section{Polynomial Interpolation and Approximation}

The foundation of spectral methods rests on polynomial interpolation at carefully chosen nodes. Let $\\{x_j\\}_{j=0}^N$ be a set of distinct interpolation nodes in $[-1, 1]$. The unique polynomial $p_N$ of degree at most $N$ that interpolates a function $u$ at these nodes can be written using the Lagrange basis:
\\begin{equation}
  p_N(x) = \\sum_{j=0}^{N} u(x_j) \\ell_j(x), \\quad \\ell_j(x) = \\prod_{\\substack{k=0 \\\\ k \\neq j}}^{N} \\frac{x - x_k}{x_j - x_k}
\\end{equation}

\\begin{definition}[Lebesgue Constant]
The Lebesgue constant associated with the node set $\\{x_j\\}_{j=0}^N$ is defined as:
\\begin{equation}
  \\Lambda_N = \\max_{x \\in [-1,1]} \\sum_{j=0}^{N} |\\ell_j(x)|
\\end{equation}
\\end{definition}

The Lebesgue constant quantifies the stability of polynomial interpolation. For equispaced nodes, $\\Lambda_N$ grows exponentially with $N$, leading to the well-known Runge phenomenon. In contrast, Chebyshev nodes yield $\\Lambda_N = O(\\log N)$, providing nearly optimal interpolation.

\\section{Gauss Quadrature}

Spectral methods require efficient and accurate numerical integration. Gaussian quadrature rules achieve the highest possible algebraic accuracy for polynomial integrands:
\\begin{equation}
  \\int_{-1}^{1} f(x) w(x) \\, dx \\approx \\sum_{j=0}^{N} w_j f(x_j)
\\end{equation}
where $\\{x_j\\}$ are the roots of the $(N+1)$-th degree orthogonal polynomial associated with the weight function $w(x)$, and $\\{w_j\\}$ are the corresponding quadrature weights.

\\begin{table}[htbp]
\\centering
\\caption{Comparison of standard Gaussian quadrature rules.}
\\label{tab:quadrature}
\\begin{tabular}{@{}llcc@{}}
\\toprule
\\textbf{Rule} & \\textbf{Weight $w(x)$} & \\textbf{Degree of Exactness} & \\textbf{Includes Endpoints} \\\\
\\midrule
Gauss--Legendre       & $1$                   & $2N+1$ & No  \\\\
Gauss--Lobatto        & $1$                   & $2N-1$ & Yes \\\\
Gauss--Chebyshev      & $(1-x^2)^{-1/2}$     & $2N+1$ & No  \\\\
Gauss--Jacobi         & $(1-x)^\\alpha(1+x)^\\beta$ & $2N+1$ & No  \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\section{The Spectral Element Method}

The spectral element method (SEM) combines the geometric flexibility of finite elements with the high-order accuracy of spectral methods. The computational domain $\\Omega$ is decomposed into non-overlapping elements $\\{\\Omega_e\\}_{e=1}^{E}$:
\\begin{equation}
  \\overline{\\Omega} = \\bigcup_{e=1}^{E} \\overline{\\Omega}_e, \\quad \\Omega_i \\cap \\Omega_j = \\emptyset \\text{ for } i \\neq j
\\end{equation}

Within each element, the solution is approximated by high-degree polynomials using a Gauss--Lobatto--Legendre (GLL) nodal basis. The GLL nodes include the element endpoints, facilitating $C^0$ continuity across elements through simple nodal matching.

\\begin{proposition}[SEM Error Estimate]
Let $u \\in H^s(\\Omega)$ with $s > 1$, and let $u_{N,h}$ be the SEM approximation with polynomial degree $N$ and element size $h$. Then:
\\begin{equation}
  \\|u - u_{N,h}\\|_{H^1(\\Omega)} \\leq C h^{\\min(s,N)-1} N^{1-s} \\|u\\|_{H^s(\\Omega)}
\\end{equation}
\\end{proposition}

This estimate reveals the dual convergence mechanism of the SEM: algebraic convergence in $h$ (mesh refinement) and spectral convergence in $N$ (polynomial enrichment). In practice, $p$-refinement (increasing $N$) is preferred for smooth solutions, while $h$-refinement is used to resolve singularities and boundary layers.

\\chapter{Stabilized Spectral Elements for the Navier--Stokes Equations}
\\label{ch:navier_stokes}

\\section{Weak Formulation}

We consider the time-dependent incompressible Navier--Stokes equations~\\eqref{eq:ns_momentum}--\\eqref{eq:ns_continuity} on a bounded domain $\\Omega \\subset \\mathbb{R}^d$ ($d = 2, 3$) with suitable boundary conditions. The weak formulation seeks $(\\mathbf{u}, p) \\in \\mathbf{V} \\times Q$ such that for all $(\\mathbf{v}, q) \\in \\mathbf{V} \\times Q$:
\\begin{align}
  \\left(\\frac{\\partial \\mathbf{u}}{\\partial t}, \\mathbf{v}\\right) + a(\\mathbf{u}, \\mathbf{v}) + c(\\mathbf{u}; \\mathbf{u}, \\mathbf{v}) + b(\\mathbf{v}, p) &= (\\mathbf{f}, \\mathbf{v}) \\\\
  b(\\mathbf{u}, q) &= 0
\\end{align}
where $a(\\cdot,\\cdot)$ is the viscous bilinear form, $c(\\cdot;\\cdot,\\cdot)$ is the convective trilinear form, and $b(\\cdot,\\cdot)$ is the pressure-velocity coupling form.

\\section{Stabilization Strategy}

A well-known difficulty in the spectral element discretization of the Navier--Stokes equations is the need to satisfy the inf-sup (LBB) condition. We propose a new pressure stabilization technique based on polynomial filtering that maintains spectral accuracy while eliminating spurious pressure modes.

The key idea is to introduce a spectrally small perturbation to the continuity equation:
\\begin{equation}
  b(\\mathbf{u}_N, q_N) - \\epsilon_N (\\Pi_{N-2} p_N, \\Pi_{N-2} q_N) = 0
\\end{equation}
where $\\Pi_{N-2}$ is the $L^2$ projection onto polynomials of degree $N-2$ and $\\epsilon_N = O(N^{-2s})$ for solutions in $H^s$.

\\section{Numerical Results}

We validate our stabilized formulation on two benchmark problems: lid-driven cavity flow and flow past a circular cylinder. For the cavity flow at $\\text{Re} = 1000$, our method produces smooth pressure fields without oscillations while maintaining spectral convergence rates. For the cylinder flow at $\\text{Re} = 100$, we accurately capture the Von K\\'{a}rm\\'{a}n vortex street with a coarse spectral element mesh ($E = 48$ elements, $N = 8$).

\\chapter{Conclusions and Future Work}
\\label{ch:conclusions}

\\section{Summary of Contributions}

This thesis has developed three novel spectral methods for nonlinear PDEs with applications to fluid dynamics:

\\begin{enumerate}
\\item A stabilized spectral element method for the incompressible Navier--Stokes equations that eliminates spurious pressure modes while preserving exponential convergence.

\\item An adaptive spectral method for singularly perturbed convection-diffusion equations with rigorous \\textit{a posteriori} error estimates.

\\item A spectral collocation method for Stefan-type free-boundary problems with a Newton-based solver for the coupled system.
\\end{enumerate}

\\section{Future Directions}

Several promising research directions emerge from this work. First, extending the stabilized spectral element formulation to compressible flows and turbulence modeling using large eddy simulation (LES) would be a natural next step. Second, the adaptive spectral method could be generalized to handle systems of PDEs and multiphysics problems. Third, the free-boundary methodology could be applied to more complex phase-change problems, including dendritic solidification and multi-component alloy systems.

\\appendix

\\chapter{Proof of the Main Convergence Theorem}
\\label{app:proof}

\\begin{proof}
We provide the detailed proof of Theorem~3.1 stated in Chapter~3. Let $e_N = u - u_N$ denote the approximation error. By the triangle inequality:
\\begin{equation}
  \\|e_N\\|_{H^1} \\leq \\|u - \\Pi_N u\\|_{H^1} + \\|\\Pi_N u - u_N\\|_{H^1}
\\end{equation}
The first term is the best approximation error, bounded by standard approximation theory. For the second term, we use the coercivity of the bilinear form $a(\\cdot,\\cdot)$ and the stability of the stabilization operator to obtain the desired estimate. The full technical details involve careful tracking of the stabilization parameter $\\epsilon_N$ and its interaction with the polynomial degree.
\\end{proof}

\\bibliographystyle{plainnat}
% \\bibliography{references}

\\begin{thebibliography}{10}

\\bibitem[Canuto et~al.(2006)]{canuto2006spectral}
C.~Canuto, M.~Y. Hussaini, A.~Quarteroni, and T.~A. Zang.
\\newblock \\textit{Spectral Methods: Fundamentals in Single Domains}.
\\newblock Springer, 2006.

\\bibitem[Karniadakis and Sherwin(2005)]{karniadakis2005spectral}
G.~E. Karniadakis and S.~J. Sherwin.
\\newblock \\textit{Spectral/hp Element Methods for Computational Fluid Dynamics}.
\\newblock Oxford University Press, 2nd edition, 2005.

\\bibitem[Deville et~al.(2002)]{deville2002high}
M.~O. Deville, P.~F. Fischer, and E.~H. Mund.
\\newblock \\textit{High-Order Methods for Incompressible Fluid Flow}.
\\newblock Cambridge University Press, 2002.

\\bibitem[Trefethen(2000)]{trefethen2000spectral}
L.~N. Trefethen.
\\newblock \\textit{Spectral Methods in MATLAB}.
\\newblock SIAM, 2000.

\\end{thebibliography}

\\end{document}
`,
  },
  {
    id: "presentation-beamer",
    name: "Presentation (Beamer)",
    description: "Slide deck for talks, lectures, and conferences",
    category: "academic",
    subcategory: "presentations",
    tags: ["beamer", "slides", "talk", "lecture", "conference", "presentation"],
    icon: "Monitor",
    documentClass: "beamer",
    mainFileName: "main.tex",
    accentColor: "#f59e0b",
    hasBibliography: false,
    aspectRatio: "16/10",
    packages: [
      { name: "amsmath", description: "AMS mathematical typesetting" },
      { name: "graphicx", description: "Enhanced graphics support" },
    ],
    content: `\\documentclass[aspectratio=169]{beamer}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{listings}
\\usepackage{tikz}
\\usetikzlibrary{shapes,arrows,positioning}

\\usetheme{Madrid}
\\usecolortheme{whale}
\\setbeamertemplate{blocks}[rounded][shadow=false]

\\definecolor{codegreen}{rgb}{0,0.5,0}
\\definecolor{codegray}{rgb}{0.5,0.5,0.5}
\\definecolor{codepurple}{rgb}{0.58,0,0.82}
\\definecolor{backcolour}{rgb}{0.95,0.95,0.97}

\\lstset{
  backgroundcolor=\\color{backcolour},
  basicstyle=\\ttfamily\\tiny,
  keywordstyle=\\color{blue!80!black}\\bfseries,
  commentstyle=\\color{codegreen}\\itshape,
  stringstyle=\\color{codepurple},
  breaklines=true,
  frame=none,
  numbers=left,
  numberstyle=\\tiny\\color{codegray},
  tabsize=2
}

\\title[Deep RL for Robotics]{Deep Reinforcement Learning\\\\for Autonomous Robot Navigation}
\\subtitle{From Simulation to Real-World Deployment}
\\author[Chen \\& Nakamura]{Dr.\\\\ Wei Chen\\inst{1} \\and Prof.\\\\ Yuki Nakamura\\inst{2}}
\\institute[MIT \\& UTokyo]{\\inst{1}MIT CSAIL \\and \\inst{2}University of Tokyo}
\\date{International Conference on Robotics and Automation\\\\May 2025}

\\begin{document}

% ──── Title Slide ────
\\begin{frame}
  \\titlepage
\\end{frame}

% ──── Outline ────
\\begin{frame}{Outline}
  \\tableofcontents
\\end{frame}

% ════════════════════════════════
\\section{Introduction}
% ════════════════════════════════

\\begin{frame}{The Challenge of Autonomous Navigation}
  \\begin{columns}[T]
    \\begin{column}{0.55\\textwidth}
      \\textbf{Key challenges:}
      \\begin{itemize}
        \\item Complex, dynamic environments
        \\item Partial observability from onboard sensors
        \\item Real-time decision making under uncertainty
        \\item Safe exploration during training
        \\item Sim-to-real transfer gap
      \\end{itemize}

      \\vspace{0.5cm}
      \\textbf{Our approach:}\\\\
      Use deep reinforcement learning with domain randomization and curriculum learning to train navigation policies in simulation, then transfer to real robots.
    \\end{column}
    \\begin{column}{0.4\\textwidth}
      \\begin{tikzpicture}[scale=0.6, every node/.style={scale=0.7}]
        \\draw[thick, fill=blue!10] (0,0) rectangle (5,5);
        \\node at (2.5,5.3) {\\textbf{Environment}};
        \\filldraw[red!70!black] (1,1) circle (0.3) node[below=4pt] {Robot};
        \\filldraw[green!60!black] (4,4) circle (0.3) node[below=4pt] {Goal};
        \\filldraw[gray] (2,3) rectangle (3,3.5);
        \\filldraw[gray] (1.5,2) rectangle (2,2.8);
        \\filldraw[gray] (3.5,1.5) rectangle (4.2,2);
        \\node[gray] at (2.5,1.8) {\\tiny obstacles};
        \\draw[->,thick,red!70!black,dashed] (1,1) -- (1.5,1.8) -- (2.5,2.5) -- (3.5,3.2) -- (4,4);
      \\end{tikzpicture}
    \\end{column}
  \\end{columns}
\\end{frame}

% ════════════════════════════════
\\section{Background}
% ════════════════════════════════

\\begin{frame}{Reinforcement Learning Basics}
  \\begin{block}{Markov Decision Process (MDP)}
    An MDP is defined by the tuple $(\\mathcal{S}, \\mathcal{A}, P, R, \\gamma)$:
    \\begin{itemize}
      \\item $\\mathcal{S}$: state space \\quad $\\mathcal{A}$: action space
      \\item $P(s' | s, a)$: transition dynamics
      \\item $R(s, a)$: reward function \\quad $\\gamma$: discount factor
    \\end{itemize}
  \\end{block}

  \\vspace{0.3cm}
  \\begin{alertblock}{Objective}
    Find policy $\\pi^*$ that maximizes expected cumulative reward:
    \\begin{equation*}
      \\pi^* = \\arg\\max_\\pi \\; \\mathbb{E}_{\\tau \\sim \\pi} \\left[ \\sum_{t=0}^{T} \\gamma^t R(s_t, a_t) \\right]
    \\end{equation*}
  \\end{alertblock}

  \\begin{exampleblock}{Key Insight}
    Deep RL uses neural networks to approximate $\\pi(a|s)$ or $Q(s,a)$, enabling learning in continuous, high-dimensional state-action spaces.
  \\end{exampleblock}
\\end{frame}

\\begin{frame}{Policy Gradient Methods}
  \\textbf{Proximal Policy Optimization (PPO)} is our algorithm of choice:

  \\begin{equation*}
    L^{\\text{CLIP}}(\\theta) = \\hat{\\mathbb{E}}_t \\left[ \\min\\left( r_t(\\theta) \\hat{A}_t, \\; \\text{clip}(r_t(\\theta), 1{-}\\epsilon, 1{+}\\epsilon) \\hat{A}_t \\right) \\right]
  \\end{equation*}

  where $r_t(\\theta) = \\frac{\\pi_\\theta(a_t|s_t)}{\\pi_{\\theta_{\\text{old}}}(a_t|s_t)}$ is the probability ratio.

  \\vspace{0.3cm}
  \\textbf{Advantages of PPO:}
  \\begin{enumerate}
    \\item Stable training with clipped objective
    \\item Sample efficient with multiple epochs per batch
    \\item Works well with both continuous and discrete actions
    \\item Easy to parallelize across environments
  \\end{enumerate}
\\end{frame}

% ════════════════════════════════
\\section{Methodology}
% ════════════════════════════════

\\begin{frame}{System Architecture}
  \\begin{center}
  \\begin{tikzpicture}[
    node distance=1.2cm,
    box/.style={rectangle, draw, fill=blue!15, rounded corners, minimum width=2cm, minimum height=0.8cm, font=\\small},
    arrow/.style={->, thick, >=stealth}
  ]
    \\node[box, fill=green!15] (sensor) {LiDAR + Camera};
    \\node[box, right=of sensor] (encoder) {Perception Encoder};
    \\node[box, right=of encoder] (policy) {Policy Network};
    \\node[box, right=of policy, fill=red!15] (action) {Motor Commands};

    \\node[box, below=0.8cm of encoder, fill=yellow!15] (map) {Local Map};
    \\node[box, below=0.8cm of policy, fill=orange!15] (value) {Value Network};

    \\draw[arrow] (sensor) -- (encoder);
    \\draw[arrow] (encoder) -- (policy);
    \\draw[arrow] (policy) -- (action);
    \\draw[arrow] (encoder) -- (map);
    \\draw[arrow] (map) -- (policy);
    \\draw[arrow] (encoder) -- (value);
  \\end{tikzpicture}
  \\end{center}

  \\vspace{0.3cm}
  \\begin{itemize}
    \\item \\textbf{Perception Encoder}: CNN processes LiDAR scans and depth images
    \\item \\textbf{Local Map}: Occupancy grid built from sensor history
    \\item \\textbf{Policy Network}: Outputs velocity commands $(v, \\omega)$
    \\item \\textbf{Value Network}: Estimates state value for advantage computation
  \\end{itemize}
\\end{frame}

\\begin{frame}[fragile]{Training Code}
  \\begin{lstlisting}[language=Python]
import torch
from stable_baselines3 import PPO
from navigation_env import NavigationEnv

# Create vectorized training environments
env = make_vec_env(NavigationEnv, n_envs=16, env_kwargs={
    "map_size": 10.0,
    "max_obstacles": 20,
    "domain_randomization": True,
})

# Configure PPO with custom network
model = PPO(
    "MultiInputPolicy",
    env,
    learning_rate=3e-4,
    n_steps=2048,
    batch_size=256,
    n_epochs=10,
    gamma=0.99,
    gae_lambda=0.95,
    clip_range=0.2,
    verbose=1,
    tensorboard_log="./logs/",
)

# Train for 10M timesteps with curriculum
model.learn(total_timesteps=10_000_000,
            callback=CurriculumCallback())
  \\end{lstlisting}
\\end{frame}

% ════════════════════════════════
\\section{Results}
% ════════════════════════════════

\\begin{frame}{Simulation Results}
  \\begin{table}
    \\centering
    \\caption{Navigation performance across environment difficulties}
    \\begin{tabular}{@{}lccc@{}}
      \\toprule
      \\textbf{Method} & \\textbf{Success (\\%)} & \\textbf{Collision (\\%)} & \\textbf{Avg.\\\\ Time (s)} \\\\
      \\midrule
      Bug2 Algorithm       & 62.3 & 15.2 & 34.7 \\\\
      RRT*                 & 78.1 & 8.4  & 28.3 \\\\
      DWA Planner          & 71.5 & 12.1 & 31.2 \\\\
      Vanilla PPO          & 81.4 & 6.7  & 22.8 \\\\
      SAC                  & 83.2 & 5.9  & 21.5 \\\\
      \\midrule
      \\textbf{Ours (PPO+DR+CL)} & \\textbf{94.7} & \\textbf{2.1} & \\textbf{18.3} \\\\
      \\bottomrule
    \\end{tabular}
  \\end{table}

  \\begin{itemize}
    \\item DR = Domain Randomization, CL = Curriculum Learning
    \\item Evaluated on 1000 randomly generated environments
    \\item Our method achieves \\textbf{94.7\\%} success rate with only \\textbf{2.1\\%} collisions
  \\end{itemize}
\\end{frame}

\\begin{frame}{Sim-to-Real Transfer}
  \\begin{columns}[T]
    \\begin{column}{0.5\\textwidth}
      \\textbf{Real-world experiments:}
      \\begin{itemize}
        \\item TurtleBot3 Waffle Pi platform
        \\item Hokuyo LiDAR + Intel RealSense
        \\item 5 different indoor environments
        \\item 50 trials per environment
      \\end{itemize}

      \\vspace{0.3cm}
      \\textbf{Key findings:}
      \\begin{enumerate}
        \\item Zero-shot transfer: 78\\% success
        \\item With 100 real episodes fine-tuning: 91\\% success
        \\item Average planning time: 12ms (real-time)
      \\end{enumerate}
    \\end{column}
    \\begin{column}{0.45\\textwidth}
      \\begin{tikzpicture}[scale=0.55]
        \\begin{scope}
          \\draw[->] (0,0) -- (6,0) node[below] {\\tiny Fine-tune episodes};
          \\draw[->] (0,0) -- (0,5) node[left] {\\tiny Success \\%};
          \\foreach \\y in {20,40,60,80,100} {
            \\draw (-0.1,{\\y/20}) -- (0.1,{\\y/20});
            \\node[left,font=\\tiny] at (-0.1,{\\y/20}) {\\y};
          }
          \\foreach \\x/\\l in {1/0,2/25,3/50,4/100,5/200} {
            \\draw (\\x,-0.1) -- (\\x,0.1);
            \\node[below,font=\\tiny] at (\\x,-0.1) {\\l};
          }
          \\draw[thick,blue,mark=*] plot coordinates {(1,3.9) (2,4.1) (3,4.35) (4,4.55) (5,4.7)};
          \\draw[thick,red,dashed,mark=square*] plot coordinates {(1,2.5) (2,3.0) (3,3.4) (4,3.9) (5,4.2)};
          \\node[font=\\tiny,blue] at (4.5,4.9) {Ours};
          \\node[font=\\tiny,red] at (4.5,3.7) {Baseline};
        \\end{scope}
      \\end{tikzpicture}
    \\end{column}
  \\end{columns}
\\end{frame}

% ════════════════════════════════
\\section{Conclusion}
% ════════════════════════════════

\\begin{frame}{Summary and Future Work}
  \\textbf{Key contributions:}
  \\begin{enumerate}
    \\item Novel deep RL framework for autonomous navigation combining PPO with domain randomization and curriculum learning
    \\item State-of-the-art simulation performance: \\textbf{94.7\\%} success rate
    \\item Successful sim-to-real transfer with \\textbf{91\\%} real-world success after minimal fine-tuning
    \\item Real-time inference at \\textbf{12ms} per decision on embedded hardware
  \\end{enumerate}

  \\vspace{0.5cm}
  \\textbf{Future directions:}
  \\begin{itemize}
    \\item Multi-robot coordination and formation control
    \\item Outdoor navigation with GPS-denied environments
    \\item Integration with semantic scene understanding
    \\item Formal safety guarantees via constrained RL
  \\end{itemize}

  \\vspace{0.5cm}
  \\centering
  \\textbf{\\large Thank you! Questions?}\\\\[0.3cm]
  \\small\\texttt{weichen@mit.edu} \\quad|\\quad \\texttt{github.com/wchen/nav-rl}
\\end{frame}

% ──── References ────
\\begin{frame}[allowframebreaks]{References}
  \\tiny
  \\begin{thebibliography}{10}
  \\bibitem{schulman2017ppo} J.~Schulman et al., \`\`Proximal policy optimization algorithms,'' \\textit{arXiv:1707.06347}, 2017.
  \\bibitem{tobin2017domain} J.~Tobin et al., \`\`Domain randomization for transferring deep neural networks from simulation to the real world,'' in \\textit{IROS}, 2017.
  \\bibitem{mnih2015dqn} V.~Mnih et al., \`\`Human-level control through deep reinforcement learning,'' \\textit{Nature}, vol.~518, pp.~529--533, 2015.
  \\bibitem{tai2017virtual} L.~Tai, G.~Paolo, and M.~Liu, \`\`Virtual-to-real deep reinforcement learning: Continuous control of mobile robots for mapless navigation,'' in \\textit{IROS}, 2017.
  \\end{thebibliography}
\\end{frame}

\\end{document}
`,
  },
  {
    id: "poster-academic",
    name: "Academic Poster",
    description: "Conference or research poster with multi-column layout",
    category: "academic",
    subcategory: "posters",
    tags: ["poster", "conference", "research", "a0", "a1", "multi-column"],
    icon: "Layout",
    documentClass: "a0poster",
    mainFileName: "main.tex",
    accentColor: "#ec4899",
    hasBibliography: false,
    aspectRatio: "3/4",
    packages: [
      { name: "amsmath", description: "AMS mathematical typesetting" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "multicol", description: "Multi-column layouts" },
      { name: "geometry", description: "Page layout customization" },
      { name: "xcolor", description: "Color support" },
    ],
    content: `\\documentclass[a0paper,portrait]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{multicol}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{xcolor}
\\usepackage{tikz}
\\usepackage{enumitem}
\\usepackage{booktabs}
\\usepackage{microtype}

\\pagestyle{empty}

% ──── Color Theme ────
\\definecolor{headerblue}{HTML}{1B3A5C}
\\definecolor{accentblue}{HTML}{2E86C1}
\\definecolor{lightbg}{HTML}{EBF5FB}
\\definecolor{darktext}{HTML}{2C3E50}
\\definecolor{sectioncolor}{HTML}{1A5276}
\\definecolor{boxbg}{HTML}{F4F8FB}

% ──── Section styling ────
\\makeatletter
\\renewcommand{\\section}{\\@startsection{section}{1}{0pt}%
  {-2ex plus -0.5ex minus -0.2ex}{1.5ex plus 0.3ex}%
  {\\fontsize{40}{48}\\selectfont\\bfseries\\color{sectioncolor}}}
\\makeatother

\\renewcommand{\\familydefault}{\\sfdefault}

% ──── Poster body font size ────
\\newcommand{\\posterbody}{\\fontsize{28}{38}\\selectfont}
\\newcommand{\\postertable}{\\fontsize{26}{34}\\selectfont}

\\begin{document}

% ════════════════════════════════════════════
% HEADER
% ════════════════════════════════════════════
\\begin{tikzpicture}[remember picture, overlay]
  \\fill[headerblue] ([yshift=0cm]current page.north west) rectangle ([yshift=-18cm]current page.north east);
\\end{tikzpicture}

\\vspace*{-1cm}
\\begin{center}
  {\\color{white}\\fontsize{80}{96}\\selectfont\\bfseries
  Machine Learning--Guided Drug Discovery:\\\\[0.4cm]
  Predicting Protein--Ligand Binding Affinity\\\\[0.4cm]
  with Graph Neural Networks}\\\\[2cm]
  {\\color{white}\\fontsize{40}{48}\\selectfont
  \\textbf{Elena Vasquez}$^1$, \\textbf{Thomas Wright}$^{1,2}$, \\textbf{Kenji Yamamoto}$^2$, \\textbf{Prof. Laura Kingston}$^1$}\\\\[1cm]
  {\\color{white!85}\\fontsize{34}{42}\\selectfont
  $^1$Department of Biochemistry, University of Oxford \\quad\\quad
  $^2$DeepMind, London, UK}\\\\[0.6cm]
  {\\color{accentblue!40}\\fontsize{30}{36}\\selectfont
  Contact: elena.vasquez@bioch.ox.ac.uk \\quad|\\quad ICML 2025 -- Poster \\#247}
\\end{center}

\\vspace{3cm}

% ════════════════════════════════════════════
% BODY -- Three Columns
% ════════════════════════════════════════════
\\setlength{\\columnsep}{3cm}
\\begin{multicols}{3}

% ──── Introduction ────
\\section*{Introduction}

\\posterbody

Drug discovery is a lengthy and expensive process, with the average new drug requiring over 10 years and \\$2.6 billion to develop. A critical bottleneck is the accurate prediction of protein--ligand binding affinity, which determines whether a candidate molecule will effectively interact with its target protein.

\\vspace{1cm}

\\textbf{Traditional approaches:}
\\begin{itemize}[leftmargin=1.5em, itemsep=10pt]
  \\item Molecular docking (AutoDock, Glide) -- fast but inaccurate
  \\item Molecular dynamics simulations -- accurate but computationally prohibitive
  \\item Classical QSAR models -- limited to predefined descriptors
\\end{itemize}

\\vspace{1cm}

\\textbf{Our contribution:} We propose \\textbf{AffinityGNN}, a graph neural network that operates directly on the 3D molecular graph of the protein--ligand complex to predict binding free energy ($\\Delta G$) with near-experimental accuracy.

\\vspace{1.5cm}

% ──── Methods ────
\\section*{Methods}

\\posterbody

\\textbf{Graph Construction.} We represent the protein--ligand complex as a heterogeneous graph $G = (V_P \\cup V_L, E)$ where:
\\begin{itemize}[leftmargin=1.5em, itemsep=10pt]
  \\item $V_P$: protein residue nodes (C$\\alpha$ atoms)
  \\item $V_L$: ligand heavy atom nodes
  \\item $E$: edges based on spatial proximity ($< 8$\\AA)
\\end{itemize}

\\vspace{1cm}

\\textbf{Architecture.} AffinityGNN consists of:
\\begin{enumerate}[leftmargin=1.5em, itemsep=10pt]
  \\item Node feature encoder (atom type, charge, hybridization)
  \\item 6 layers of message-passing with attention
  \\item Graph-level readout with Set2Set pooling
  \\item Prediction head: 3-layer MLP $\\rightarrow \\Delta G$
\\end{enumerate}

\\vspace{1cm}

\\textbf{Message Passing:}
\\begin{equation*}
  {\\fontsize{32}{40}\\selectfont h_i^{(l+1)} = \\sigma\\!\\left( \\sum_{j \\in \\mathcal{N}(i)} \\alpha_{ij}^{(l)} W^{(l)} h_j^{(l)} + b^{(l)} \\right)}
\\end{equation*}

\\vspace{0.5cm}
where $\\alpha_{ij}$ are attention weights incorporating edge features (distance, angle).

\\vspace{1cm}

\\textbf{Training.} We use a combined loss:
\\begin{equation*}
  {\\fontsize{32}{40}\\selectfont \\mathcal{L} = \\underbrace{\\|\\hat{y} - y\\|_2^2}_{\\text{MSE}} + \\lambda \\underbrace{(1 - \\rho(\\hat{y}, y))}_{\\text{Correlation}}}
\\end{equation*}

\\vspace{1.5cm}

% ──── Data ────
\\section*{Datasets}

\\posterbody

\\textbf{Training Data:}
\\begin{itemize}[leftmargin=1.5em, itemsep=10pt]
  \\item PDBbind v2020 refined set (5,316 complexes)
  \\item BindingDB kinase subset (12,400 complexes)
  \\item Custom curated GPCR dataset (3,200 complexes)
\\end{itemize}

\\vspace{1cm}

\\textbf{Data Augmentation:}
\\begin{itemize}[leftmargin=1.5em, itemsep=10pt]
  \\item Random rotation and translation of coordinates
  \\item Gaussian noise on atomic positions ($\\sigma = 0.1$\\AA)
  \\item Subgraph sampling for large complexes
\\end{itemize}

\\columnbreak

% ──── Results ────
\\section*{Results}

\\posterbody

\\textbf{Benchmark Performance} on PDBbind v2020 core set:

\\vspace{1cm}

\\begin{center}
\\renewcommand{\\arraystretch}{1.6}
{\\postertable
\\begin{tabular}{@{}lcc@{}}
\\toprule
\\textbf{Method} & \\textbf{RMSE} & \\textbf{Pearson $R$} \\\\
\\midrule
AutoDock Vina  & 2.41 & 0.604 \\\\
RF-Score v3    & 1.82 & 0.713 \\\\
OnionNet-2     & 1.54 & 0.782 \\\\
PLIP-GNN       & 1.41 & 0.801 \\\\
\\midrule
\\textbf{AffinityGNN} & \\textbf{1.18} & \\textbf{0.862} \\\\
\\bottomrule
\\end{tabular}}
\\end{center}

\\vspace{2cm}

\\textbf{Virtual Screening on DUD-E:}

\\vspace{1cm}

\\begin{center}
\\renewcommand{\\arraystretch}{1.6}
{\\postertable
\\begin{tabular}{@{}lcc@{}}
\\toprule
\\textbf{Target} & \\textbf{AUC-ROC} & \\textbf{EF$_{1\\%}$} \\\\
\\midrule
CDK2 (kinase)     & 0.94 & 42.3 \\\\
COX-2 (enzyme)    & 0.91 & 38.7 \\\\
EGFR (receptor)   & 0.93 & 45.1 \\\\
HIV-RT (viral)    & 0.89 & 31.4 \\\\
\\midrule
\\textbf{Average}  & \\textbf{0.92} & \\textbf{39.4} \\\\
\\bottomrule
\\end{tabular}}
\\end{center}

\\vspace{2cm}

\\textbf{Experimental Validation.} We used AffinityGNN to screen 50,000 compounds against SARS-CoV-2 main protease (M$^{\\text{pro}}$). The top 100 predictions were synthesized and tested:
\\begin{itemize}[leftmargin=1.5em, itemsep=10pt]
  \\item 23 compounds showed IC$_{50} < 10\\,\\mu$M
  \\item 4 compounds showed IC$_{50} < 100\\,$nM
  \\item Best hit: IC$_{50} = 28\\,$nM (comparable to nirmatrelvir)
\\end{itemize}

\\vspace{2cm}

\\textbf{Generalization Across Targets:}

\\vspace{1cm}

\\begin{center}
\\renewcommand{\\arraystretch}{1.6}
{\\postertable
\\begin{tabular}{@{}lcc@{}}
\\toprule
\\textbf{Protein Family} & \\textbf{RMSE} & \\textbf{$N$} \\\\
\\midrule
Kinases        & 1.12 & 847 \\\\
Proteases      & 1.21 & 523 \\\\
GPCRs          & 1.35 & 312 \\\\
Nuclear rec.   & 1.19 & 198 \\\\
\\bottomrule
\\end{tabular}}
\\end{center}

\\columnbreak

% ──── Analysis ────
\\section*{Ablation \\& Analysis}

\\posterbody

\\textbf{Component Contributions:}

\\vspace{1cm}

\\begin{center}
\\renewcommand{\\arraystretch}{1.6}
{\\postertable
\\begin{tabular}{@{}lc@{}}
\\toprule
\\textbf{Variant} & \\textbf{RMSE} \\\\
\\midrule
Full model                   & 1.18 \\\\
$-$ Attention mechanism      & 1.34 \\\\
$-$ Edge features            & 1.29 \\\\
$-$ Correlation loss         & 1.25 \\\\
$-$ Set2Set pooling          & 1.31 \\\\
GCN baseline (no attention)  & 1.52 \\\\
\\bottomrule
\\end{tabular}}
\\end{center}

\\vspace{2cm}

\\textbf{Attention Visualization.} The learned attention weights highlight key interactions at the binding site, including hydrogen bonds, $\\pi$-stacking, and hydrophobic contacts---consistent with known biochemistry.

\\vspace{2cm}

\\textbf{Scaling Behavior.} Performance improves log-linearly with training data:

\\vspace{1cm}

\\begin{center}
\\renewcommand{\\arraystretch}{1.6}
{\\postertable
\\begin{tabular}{@{}lc@{}}
\\toprule
\\textbf{Training Size} & \\textbf{RMSE} \\\\
\\midrule
1,000 complexes   & 1.72 \\\\
5,000 complexes   & 1.38 \\\\
10,000 complexes  & 1.24 \\\\
20,916 complexes  & 1.18 \\\\
\\bottomrule
\\end{tabular}}
\\end{center}

\\vspace{2cm}

% ──── Conclusions ────
\\section*{Conclusions}

\\posterbody

\\begin{itemize}[leftmargin=1.5em, itemsep=12pt]
  \\item AffinityGNN achieves \\textbf{state-of-the-art} binding affinity prediction (RMSE = 1.18 kcal/mol)
  \\item \\textbf{Interpretable} attention mechanism reveals binding site interactions
  \\item \\textbf{Practical impact}: identified 4 potent M$^{\\text{pro}}$ inhibitors from virtual screening
  \\item Inference time: \\textbf{0.3ms per complex} (GPU), enabling large-scale screening
  \\item Code and models available at \\texttt{github.com/oxbiochem/affinitygnn}
\\end{itemize}

\\vspace{2cm}

% ──── References ────
\\section*{Key References}

{\\fontsize{24}{32}\\selectfont
\\begin{enumerate}[leftmargin=1.5em, itemsep=6pt]
  \\item Corso et al., \`\`DiffDock,'' \\textit{ICLR}, 2023.
  \\item St\\"{a}rk et al., \`\`EquiBind,'' \\textit{ICML}, 2022.
  \\item Wang et al., \`\`PDBbind v2020,'' \\textit{JCIM}, 2020.
  \\item Kipf \\& Welling, \`\`GCN,'' \\textit{ICLR}, 2017.
  \\item Veli\\v{c}kovi\\'{c} et al., \`\`GAT,'' \\textit{ICLR}, 2018.
  \\item Gilmer et al., \`\`MPNN,'' \\textit{ICML}, 2017.
\\end{enumerate}
}

\\vspace{1.5cm}

% ──── Acknowledgements ────
\\section*{Acknowledgements}

{\\fontsize{24}{32}\\selectfont
This work was supported by the Wellcome Trust (Grant 203141/Z/16/Z), EPSRC Doctoral Training Partnership, and computing resources from JADE2 (EP/T022205/1). We thank the Oxford Structural Genomics Consortium for providing crystal structures and binding data.}

\\end{multicols}

\\end{document}
`,
  },
  {
    id: "cv-modern",
    name: "CV / Resume",
    description: "Clean, professional curriculum vitae layout",
    category: "professional",
    subcategory: "cv",
    tags: ["cv", "resume", "curriculum vitae", "job", "career", "professional"],
    icon: "User",
    documentClass: "article",
    mainFileName: "main.tex",
    accentColor: "#10b981",
    hasBibliography: false,
    aspectRatio: "3/4",
    packages: [
      { name: "geometry", description: "Page layout customization" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
      { name: "enumitem", description: "List customization" },
      { name: "titlesec", description: "Section title formatting" },
    ],
    content: `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage[margin=0.65in]{geometry}
\\usepackage{hyperref}
\\usepackage{enumitem}
\\usepackage{titlesec}
\\usepackage{xcolor}
\\usepackage{tabularx}
\\usepackage{fontawesome5}
\\usepackage{microtype}
\\usepackage{multicol}

\\definecolor{primary}{HTML}{2C3E50}
\\definecolor{accent}{HTML}{2E86C1}
\\definecolor{lightgray}{HTML}{95A5A6}
\\definecolor{darktext}{HTML}{333333}

\\hypersetup{
  colorlinks=true,
  linkcolor=accent,
  urlcolor=accent
}

\\titleformat{\\section}{\\large\\bfseries\\color{primary}}{}{0em}{}[{\\color{accent}\\titlerule[1.5pt]}]
\\titlespacing{\\section}{0pt}{14pt}{6pt}

\\pagestyle{empty}
\\setlength{\\parindent}{0pt}

% Custom commands
\\newcommand{\\cventry}[4]{%
  \\textbf{#1} \\hfill {\\color{lightgray}#2}\\\\
  {\\color{accent}\\textit{#3}} \\hfill {\\color{lightgray}\\textit{#4}}\\\\[2pt]
}
\\newcommand{\\cvsep}{\\vspace{6pt}}

\\begin{document}

% ──── Header ────
\\begin{center}
  {\\fontsize{28}{34}\\selectfont\\bfseries\\color{primary} Dr.\\\\ Alexandra Chen}\\\\[8pt]
  {\\color{lightgray}\\rule{8cm}{0.5pt}}\\\\[8pt]
  {\\small
    \\faIcon{envelope}\\;\\href{mailto:a.chen@stanford.edu}{a.chen@stanford.edu} \\quad
    \\faIcon{phone}\\;+1 (650) 555-0142 \\quad
    \\faIcon{map-marker-alt}\\;Stanford, CA\\\\[4pt]
    \\faIcon{globe}\\;\\href{https://alexchen.io}{alexchen.io} \\quad
    \\faIcon{github}\\;\\href{https://github.com/alexchen}{github.com/alexchen} \\quad
    \\faIcon{linkedin}\\;\\href{https://linkedin.com/in/alexchen}{linkedin.com/in/alexchen} \\quad
    \\faIcon{graduation-cap}\\;\\href{https://scholar.google.com/citations?user=XXXXX}{Google Scholar}
  }
\\end{center}

\\vspace{4pt}

% ──── Summary ────
\\section{Summary}

Machine learning researcher with 8+ years of experience in natural language processing and large language models. Published 25+ papers at top venues (NeurIPS, ICML, ACL, EMNLP) with 3,800+ citations. Led research teams developing foundation models deployed to millions of users. Seeking faculty positions in computer science.

% ──── Education ────
\\section{Education}

\\cventry{Ph.D.\\\\ in Computer Science}{2016 -- 2021}{Stanford University}{Stanford, CA}
\\begin{itemize}[leftmargin=1.5em, nosep, itemsep=2pt]
  \\item Thesis: \`\`Efficient Transformers for Long-Range Sequence Modeling''
  \\item Advisor: Prof.\\\\ Christopher Manning \\quad Committee: Profs.\\\\ Percy Liang, Dan Jurafsky
  \\item Stanford Graduate Fellowship (SGF) recipient
\\end{itemize}

\\cvsep

\\cventry{M.S.\\\\ in Computer Science}{2014 -- 2016}{Carnegie Mellon University}{Pittsburgh, PA}
\\begin{itemize}[leftmargin=1.5em, nosep, itemsep=2pt]
  \\item Focus: Machine Learning and Language Technologies
  \\item GPA: 4.0/4.0 \\quad Dean's List all semesters
\\end{itemize}

\\cvsep

\\cventry{B.S.\\\\ in Mathematics and Computer Science}{2010 -- 2014}{MIT}{Cambridge, MA}
\\begin{itemize}[leftmargin=1.5em, nosep, itemsep=2pt]
  \\item Summa Cum Laude \\quad Phi Beta Kappa
  \\item Undergraduate thesis on spectral graph theory (awarded departmental prize)
\\end{itemize}

% ──── Experience ────
\\section{Professional Experience}

\\cventry{Senior Research Scientist}{2023 -- Present}{Google DeepMind}{Mountain View, CA}
\\begin{itemize}[leftmargin=1.5em, nosep, itemsep=2pt]
  \\item Lead a team of 8 researchers developing next-generation language models
  \\item Designed novel attention mechanisms reducing compute by 40\\% at scale
  \\item Core contributor to Gemini model family; responsible for efficiency improvements
  \\item Mentored 4 PhD interns, all placed at top research labs or faculty positions
\\end{itemize}

\\cvsep

\\cventry{Research Scientist}{2021 -- 2023}{Meta AI (FAIR)}{Menlo Park, CA}
\\begin{itemize}[leftmargin=1.5em, nosep, itemsep=2pt]
  \\item Developed sparse mixture-of-experts models for efficient inference
  \\item Led the retrieval-augmented generation (RAG) project for factual consistency
  \\item Published 8 papers; 2 received spotlight/oral designations at NeurIPS
  \\item Open-sourced model checkpoints downloaded 500K+ times
\\end{itemize}

\\cvsep

\\cventry{Research Intern}{Summers 2018, 2019}{OpenAI}{San Francisco, CA}
\\begin{itemize}[leftmargin=1.5em, nosep, itemsep=2pt]
  \\item Contributed to GPT-2 training infrastructure and evaluation framework
  \\item Developed techniques for reducing hallucination in text generation
\\end{itemize}

% ──── Selected Publications ────
\\section{Selected Publications}
{\\small
\\begin{enumerate}[leftmargin=1.5em, itemsep=3pt]
  \\item \\textbf{A.\\\\ Chen}, J.\\\\ Smith, R.\\\\ Patel. \`\`FlashLinear: Sub-Quadratic Attention via Structured State Spaces.'' \\textit{NeurIPS 2024}. \\textbf{(Oral, top 0.5\\%)}
  \\item \\textbf{A.\\\\ Chen}, M.\\\\ Johnson. \`\`Scaling Laws for Mixture-of-Experts Language Models.'' \\textit{ICML 2024}.
  \\item L.\\\\ Wang, \\textbf{A.\\\\ Chen}, K.\\\\ Lee. \`\`Retrieval-Augmented Generation with Learned Relevance.'' \\textit{ACL 2023}. \\textbf{(Best Paper Award)}
  \\item \\textbf{A.\\\\ Chen}, T.\\\\ Brown, S.\\\\ Narang. \`\`Efficient Long-Context Transformers via Sliding Window Attention.'' \\textit{NeurIPS 2022}. \\textbf{(Spotlight)}
  \\item \\textbf{A.\\\\ Chen}, C.\\\\ Manning. \`\`Linear Transformers with Gated Retention.'' \\textit{ICLR 2021}.
\\end{enumerate}
}

% ──── Awards ────
\\section{Awards \\& Honors}

\\begin{multicols}{2}
\\begin{itemize}[leftmargin=1.5em, nosep, itemsep=3pt]
  \\item ACL Best Paper Award, 2023
  \\item MIT Technology Review 35 Under 35, 2024
  \\item Stanford Graduate Fellowship, 2016--2021
  \\item NSF Graduate Research Fellowship, 2016
  \\item CRA Outstanding Undergraduate Award, 2014
  \\item Phi Beta Kappa, MIT Chapter, 2014
\\end{itemize}
\\end{multicols}

% ──── Skills ────
\\section{Technical Skills}

\\begin{tabularx}{\\textwidth}{@{}lX@{}}
\\textbf{Languages:} & Python, C++, CUDA, Julia, Rust \\\\
\\textbf{Frameworks:} & PyTorch, JAX, TensorFlow, Hugging Face, DeepSpeed, Megatron-LM \\\\
\\textbf{Infrastructure:} & Kubernetes, Slurm, TPU Pods, multi-node GPU training (up to 2048 GPUs) \\\\
\\textbf{Specialties:} & Large language models, efficient attention, distributed training, NLP \\\\
\\end{tabularx}

% ──── Service ────
\\section{Academic Service}

\\begin{itemize}[leftmargin=1.5em, nosep, itemsep=3pt]
  \\item \\textbf{Area Chair}: NeurIPS 2024, ICML 2024, ACL 2023
  \\item \\textbf{Reviewer}: NeurIPS, ICML, ICLR, ACL, EMNLP, JMLR, TACL (100+ reviews total)
  \\item \\textbf{Workshop Organizer}: \`\`Efficient NLP'' at EMNLP 2023; \`\`Scaling Laws'' at ICML 2024
  \\item \\textbf{Invited Talks}: Google, Microsoft, Meta, Amazon, Apple, NVIDIA, 15+ universities
\\end{itemize}

\\end{document}
`,
  },
  {
    id: "letter-formal",
    name: "Formal Letter",
    description: "Professional or cover letter with standard formatting",
    category: "professional",
    subcategory: "letters",
    tags: ["letter", "formal", "cover letter", "business", "correspondence"],
    icon: "Mail",
    documentClass: "letter",
    mainFileName: "main.tex",
    accentColor: "#06b6d4",
    hasBibliography: false,
    aspectRatio: "3/4",
    packages: [
      { name: "geometry", description: "Page layout customization" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
    ],
    content: `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}
\\usepackage{xcolor}
\\usepackage{enumitem}
\\usepackage{parskip}
\\usepackage{microtype}
\\usepackage{fancyhdr}
\\usepackage{lastpage}
\\usepackage{graphicx}

\\definecolor{headercolor}{HTML}{1B3A5C}
\\definecolor{accentcolor}{HTML}{2E86C1}
\\definecolor{rulecolor}{HTML}{BDC3C7}

\\hypersetup{
  colorlinks=true,
  urlcolor=accentcolor
}

\\pagestyle{fancy}
\\fancyhf{}
\\renewcommand{\\headrulewidth}{0pt}
\\fancyfoot[C]{\\small\\color{rulecolor}Page \\thepage\\\\ of \\pageref{LastPage}}

\\setlength{\\parskip}{10pt}
\\setlength{\\parindent}{0pt}

\\begin{document}

% ──── Letterhead ────
\\begin{center}
{\\color{headercolor}\\rule{\\textwidth}{2pt}}\\\\[12pt]
{\\fontsize{20}{24}\\selectfont\\bfseries\\color{headercolor} Quantum Computing Research Laboratory}\\\\[4pt]
{\\large Department of Physics --- Massachusetts Institute of Technology}\\\\[4pt]
{\\small 77 Massachusetts Avenue, Building 26-251, Cambridge, MA 02139}\\\\[2pt]
{\\small Tel: +1 (617) 253-4000 \\quad|\\quad Fax: +1 (617) 253-8000 \\quad|\\quad \\href{mailto:qcrl@mit.edu}{qcrl@mit.edu}}\\\\[8pt]
{\\color{headercolor}\\rule{\\textwidth}{0.5pt}}
\\end{center}

\\vspace{1cm}

% ──── Date and Reference ────
\\begin{flushright}
\\textbf{Date:} January 15, 2025\\\\
\\textbf{Ref:} QCRL/2025/REC-0047
\\end{flushright}

\\vspace{0.5cm}

% ──── Recipient ────
Prof.\\\\ Sarah M.\\\\ Thompson\\\\
Chair, Department of Computer Science\\\\
University of California, Berkeley\\\\
Soda Hall, Room 593\\\\
Berkeley, CA 94720

\\vspace{0.5cm}

\\textbf{Re: Letter of Recommendation for Dr.\\\\ James Liu -- Assistant Professor Position}

\\vspace{0.3cm}

Dear Professor Thompson,

I am writing to provide my strongest recommendation for Dr.\\\\ James Liu, who is applying for the tenure-track Assistant Professor position in Quantum Computing at the University of California, Berkeley. I have had the privilege of working closely with James for the past five years, first as his doctoral advisor at MIT and subsequently as a research collaborator, and I can state without reservation that he is among the most talented young researchers I have encountered in my thirty-year career.

James joined my research group in 2018 after completing his undergraduate degree in Physics and Mathematics at Caltech, where he graduated first in his class. From the outset, it was clear that James possessed an unusual combination of deep mathematical intuition, strong programming skills, and creative thinking. His doctoral research focused on developing novel quantum error correction codes for fault-tolerant quantum computation, a topic of immense theoretical and practical importance.

During his time in my lab, James made several groundbreaking contributions that have significantly advanced the field:

\\begin{enumerate}[leftmargin=2em, itemsep=4pt]
\\item \\textbf{Topological Error Correction:} James developed a new family of topological quantum error correcting codes that achieve a 3$\\times$ improvement in the error threshold compared to the standard surface code. This work, published in \\textit{Nature Physics} (2021), has been cited over 200 times and has been experimentally validated by research groups at Google and IBM.

\\item \\textbf{Efficient Decoding Algorithms:} He designed a near-linear-time decoding algorithm for his topological codes that runs in real-time on classical hardware, overcoming one of the major practical obstacles to fault-tolerant quantum computing. This work appeared in \\textit{Physical Review Letters} (2022) and received the APS Outstanding Doctoral Thesis Award.

\\item \\textbf{Noise-Adapted Codes:} Most recently, James pioneered an approach to constructing quantum error correcting codes that are optimized for the specific noise characteristics of a given quantum processor. This noise-aware approach, published in \\textit{Science} (2024), represents a paradigm shift in how the community thinks about error correction.
\\end{enumerate}

Beyond his technical accomplishments, James is an exceptional communicator and mentor. He has supervised three master's students and two undergraduate researchers, all of whom have gone on to pursue doctoral studies at leading institutions. His lectures in our graduate quantum information course consistently receive the highest evaluations, and he has a remarkable ability to make complex concepts accessible without sacrificing rigor.

James's research program is both visionary and practical. He has articulated a compelling five-year plan that bridges the gap between theoretical error correction and the engineering reality of near-term quantum devices. His proposed work on hardware-efficient codes and real-time decoding architectures addresses critical challenges that must be solved for quantum computing to achieve its transformative potential. I believe this research agenda will attract significant funding and top graduate students.

On a personal level, James is a person of exceptional integrity and collegiality. He is generous with his time, always willing to help colleagues, and has been instrumental in fostering a collaborative and inclusive research culture in our group. He actively participates in outreach activities, including organizing quantum computing workshops for underrepresented high school students in the Boston area.

In summary, I give Dr.\\\\ James Liu my highest and most enthusiastic recommendation. He has the intellectual depth, technical skill, creative vision, and personal qualities to become a leading figure in quantum computing and an outstanding faculty member. I am confident that he would be an exceptional addition to your department, and I strongly urge you to give his application the most serious consideration.

Please do not hesitate to contact me if you require any additional information. I am happy to discuss James's qualifications in further detail by phone or video call at your convenience.

\\vspace{0.8cm}

Sincerely yours,

\\vspace{1.2cm}

\\textbf{Prof.\\\\ Richard A.\\\\ Yamamoto}\\\\
William A.\\\\ Coolidge Professor of Physics\\\\
Director, Quantum Computing Research Laboratory\\\\
Massachusetts Institute of Technology\\\\
\\href{mailto:ryamamoto@mit.edu}{ryamamoto@mit.edu} \\quad|\\quad +1 (617) 253-4851

\\vspace{1cm}

{\\small\\color{rulecolor}\\textit{Enclosures: Curriculum Vitae of Dr.\\\\ James Liu; List of publications}}

\\end{document}
`,
  },
  {
    id: "report-technical",
    name: "Technical Report",
    description: "Structured report with table of contents and sections",
    category: "professional",
    subcategory: "reports",
    tags: ["report", "technical", "business", "documentation", "sections"],
    icon: "ClipboardList",
    documentClass: "report",
    mainFileName: "main.tex",
    accentColor: "#6366f1",
    hasBibliography: false,
    aspectRatio: "3/4",
    packages: [
      { name: "geometry", description: "Page layout customization" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
      { name: "booktabs", description: "Professional table formatting" },
      { name: "listings", description: "Source code typesetting" },
      { name: "xcolor", description: "Color support" },
    ],
    content: `\\documentclass[12pt,a4paper]{report}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage[margin=1in]{geometry}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{booktabs}
\\usepackage{listings}
\\usepackage{xcolor}
\\usepackage{fancyhdr}
\\usepackage{titlesec}
\\usepackage{enumitem}
\\usepackage{amsmath}
\\usepackage{tabularx}
\\usepackage{float}
\\usepackage{microtype}
\\usepackage{caption}

\\definecolor{codeblue}{HTML}{2E86C1}
\\definecolor{codebg}{HTML}{F4F6F7}
\\definecolor{codegreen}{HTML}{27AE60}
\\definecolor{codegray}{HTML}{7F8C8D}
\\definecolor{headerblue}{HTML}{1B3A5C}

\\hypersetup{
  colorlinks=true,
  linkcolor=headerblue,
  citecolor=codeblue,
  urlcolor=codeblue
}

\\lstset{
  basicstyle=\\ttfamily\\small,
  backgroundcolor=\\color{codebg},
  keywordstyle=\\color{codeblue}\\bfseries,
  commentstyle=\\color{codegreen}\\itshape,
  stringstyle=\\color{red!60!black},
  numberstyle=\\tiny\\color{codegray},
  frame=single,
  rulecolor=\\color{codegray!50},
  breaklines=true,
  numbers=left,
  tabsize=2,
  showstringspaces=false
}

% Chapter heading style
\\titleformat{\\chapter}[display]
  {\\normalfont\\LARGE\\bfseries\\color{headerblue}}{\\chaptertitlename\\\\ \\thechapter}{16pt}{\\Huge}
\\titlespacing*{\\chapter}{0pt}{-10pt}{25pt}

% Header/footer
\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[L]{\\small\\color{codegray}\\textit{Technical Report TR-2025-003}}
\\fancyhead[R]{\\small\\color{codegray}\\nouppercase{\\leftmark}}
\\fancyfoot[C]{\\thepage}
\\renewcommand{\\headrulewidth}{0.4pt}

\\begin{document}

% ──── Title Page ────
\\begin{titlepage}
\\centering
\\vspace*{1cm}

{\\color{headerblue}\\rule{\\textwidth}{2pt}}\\\\[1cm]

{\\small\\color{codegray} TECHNICAL REPORT TR-2025-003}\\\\[1cm]
{\\fontsize{28}{34}\\selectfont\\bfseries\\color{headerblue}
  Distributed Key--Value Store\\\\with Consensus-Based Replication\\\\[0.3cm]
  Design, Implementation, and\\\\Performance Analysis}\\\\[1.5cm]

{\\Large
  \\textbf{Michael Torres}, \\textbf{Ananya Krishnan}, \\textbf{Erik Johansson}}\\\\[0.5cm]
{\\large Infrastructure Engineering Team\\\\Distributed Systems Division}\\\\[1.5cm]

{\\color{headerblue}\\rule{0.6\\textwidth}{0.5pt}}\\\\[1cm]

{\\large
\\begin{tabular}{ll}
\\textbf{Document ID:} & TR-2025-003 \\\\
\\textbf{Version:} & 2.1 \\\\
\\textbf{Date:} & February 10, 2025 \\\\
\\textbf{Classification:} & Internal -- Engineering \\\\
\\textbf{Status:} & Final \\\\
\\end{tabular}}

\\vfill

{\\large Acme Cloud Systems, Inc.\\\\
1200 Technology Drive, San Jose, CA 95134}

\\end{titlepage}

% ──── Revision History ────
\\chapter*{Revision History}
\\addcontentsline{toc}{chapter}{Revision History}

\\begin{table}[H]
\\centering
\\begin{tabular}{@{}llll@{}}
\\toprule
\\textbf{Version} & \\textbf{Date} & \\textbf{Author} & \\textbf{Changes} \\\\
\\midrule
1.0 & 2024-11-15 & M.\\\\ Torres & Initial draft \\\\
1.5 & 2024-12-20 & A.\\\\ Krishnan & Added benchmarks and security analysis \\\\
2.0 & 2025-01-28 & E.\\\\ Johansson & Performance tuning and final benchmarks \\\\
2.1 & 2025-02-10 & M.\\\\ Torres & Minor corrections, final review \\\\
\\bottomrule
\\end{tabular}
\\end{table}

% ──── Executive Summary ────
\\chapter*{Executive Summary}
\\addcontentsline{toc}{chapter}{Executive Summary}

This report presents the design, implementation, and performance evaluation of \\textbf{AcmeKV}, a distributed key--value store with strong consistency guarantees based on the Raft consensus protocol. AcmeKV is designed to serve as the foundational storage layer for Acme Cloud Systems' next-generation microservices platform, replacing the existing Cassandra-based infrastructure which has proven difficult to maintain and reason about under our strong consistency requirements.

Key findings of this report include:
\\begin{itemize}[itemsep=4pt]
  \\item AcmeKV achieves \\textbf{285,000 reads/sec} and \\textbf{142,000 writes/sec} on a 5-node cluster with p99 latencies under 5ms for reads and 12ms for writes.
  \\item The system correctly maintains linearizable consistency under all tested failure scenarios, including leader failure, network partitions, and disk failures.
  \\item Compared to our existing Cassandra deployment, AcmeKV provides a \\textbf{2.3$\\times$} improvement in write latency and a \\textbf{40\\%} reduction in operational complexity as measured by incident response time.
  \\item The system is ready for production deployment with the caveats noted in Section~5.3.
\\end{itemize}

% ──── TOC ────
\\tableofcontents
\\listoftables

% ════════════════════════════════════════════
\\chapter{Introduction}
\\label{ch:introduction}
% ════════════════════════════════════════════

\\section{Motivation}

Acme Cloud Systems' microservices platform currently relies on Apache Cassandra as its primary key--value store. While Cassandra provides excellent horizontal scalability and availability, its eventual consistency model has been a persistent source of bugs and operational complexity. Over the past 18 months, our incident reports show that 34\\% of P1 incidents were attributable to stale reads or write conflicts arising from Cassandra's eventual consistency guarantees.

As our platform has evolved, we have identified a growing set of use cases that require strong consistency:
\\begin{enumerate}[itemsep=4pt]
  \\item \\textbf{Configuration management}: Service configurations must be read with linearizable guarantees to prevent inconsistent behavior across replicas.
  \\item \\textbf{Distributed locking}: Leader election and distributed locks require consensus to function correctly.
  \\item \\textbf{Financial transactions}: Payment processing requires serializable isolation to prevent double-spending.
  \\item \\textbf{Metadata catalogs}: Dataset and schema registries must reflect the latest state to avoid data corruption.
\\end{enumerate}

\\section{Requirements}

Based on stakeholder interviews and workload analysis, we established the following requirements for AcmeKV:

\\begin{table}[H]
\\centering
\\caption{System requirements for AcmeKV.}
\\label{tab:requirements}
\\begin{tabular}{@{}llc@{}}
\\toprule
\\textbf{ID} & \\textbf{Requirement} & \\textbf{Priority} \\\\
\\midrule
R1 & Linearizable read/write consistency & Must \\\\
R2 & $\\geq$100K writes/sec (5-node cluster) & Must \\\\
R3 & p99 read latency $<$ 10ms & Must \\\\
R4 & Automatic leader failover $<$ 5 seconds & Must \\\\
R5 & Online cluster membership changes & Should \\\\
R6 & Point-in-time snapshots for backup & Should \\\\
R7 & TLS encryption for all communication & Must \\\\
R8 & Role-based access control (RBAC) & Should \\\\
R9 & Observability (metrics, tracing, logging) & Must \\\\
R10 & Cross-datacenter replication & Could \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\section{Scope}

This report covers the design and implementation of AcmeKV version 1.0, addressing requirements R1--R9. Cross-datacenter replication (R10) is deferred to version 2.0 and will be covered in a subsequent report.

% ════════════════════════════════════════════
\\chapter{System Design}
\\label{ch:design}
% ════════════════════════════════════════════

\\section{Architecture Overview}

AcmeKV follows a replicated state machine architecture built on the Raft consensus protocol. The system consists of the following core components:

\\begin{description}[style=nextline, leftmargin=2em]
  \\item[Raft Consensus Module] Implements leader election, log replication, and safety guarantees per the Raft specification. Our implementation extends the basic protocol with pre-vote, leadership transfer, and joint consensus for membership changes.
  \\item[Storage Engine] A log-structured merge-tree (LSM-tree) storage engine optimized for write-heavy workloads. The engine uses a two-level compaction strategy with bloom filters for efficient point lookups.
  \\item[API Gateway] gRPC-based API layer that routes client requests to the appropriate cluster node. Read requests can be served by any node (with a consistency check), while writes are forwarded to the leader.
  \\item[Snapshot Manager] Handles periodic snapshots of the state machine for log compaction and backup/restore operations.
\\end{description}

\\section{Consensus Protocol}

We implement the Raft consensus protocol with several optimizations for production use:

\\begin{enumerate}[itemsep=4pt]
  \\item \\textbf{Batched log replication}: Multiple client requests are batched into a single AppendEntries RPC, amortizing the cost of consensus across multiple operations.
  \\item \\textbf{Pipeline replication}: The leader sends the next batch of entries before receiving acknowledgment for the previous batch, improving throughput on high-latency networks.
  \\item \\textbf{Lease-based reads}: The leader maintains a time-based lease that allows it to serve linearizable reads without requiring a round of consensus, reducing read latency significantly.
\\end{enumerate}

The correctness of our implementation is verified through a combination of property-based testing (using Jepsen) and TLA+ model checking of the core consensus logic.

\\section{Data Model}

AcmeKV supports a simple key--value data model with the following operations:

\\begin{lstlisting}[language=Go, caption={AcmeKV core API definition.}]
service AcmeKV {
  // Put stores a key-value pair.
  rpc Put(PutRequest) returns (PutResponse);

  // Get retrieves the value for a key.
  rpc Get(GetRequest) returns (GetResponse);

  // Delete removes a key-value pair.
  rpc Delete(DeleteRequest) returns (DeleteResponse);

  // Scan returns key-value pairs in a range.
  rpc Scan(ScanRequest) returns (stream ScanResponse);

  // Txn executes a multi-key transaction.
  rpc Txn(TxnRequest) returns (TxnResponse);
}
\\end{lstlisting}

Keys are limited to 256 bytes and values to 1MB. The system supports optional TTL (time-to-live) on keys and atomic multi-key transactions with serializable isolation using optimistic concurrency control.

% ════════════════════════════════════════════
\\chapter{Performance Evaluation}
\\label{ch:performance}
% ════════════════════════════════════════════

\\section{Test Environment}

All benchmarks were conducted on a 5-node cluster with the following hardware configuration:

\\begin{table}[H]
\\centering
\\caption{Hardware configuration for benchmark cluster.}
\\begin{tabular}{@{}ll@{}}
\\toprule
\\textbf{Component} & \\textbf{Specification} \\\\
\\midrule
CPU & Intel Xeon Gold 6348 (28 cores, 2.6 GHz) \\\\
Memory & 256 GB DDR4-3200 ECC \\\\
Storage & 2$\\times$ Intel Optane P5800X 1.6TB (NVMe) \\\\
Network & 25 Gbps Ethernet (Mellanox ConnectX-6) \\\\
OS & Ubuntu 22.04 LTS (kernel 5.15) \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\section{Throughput Results}

Table~\\ref{tab:throughput} summarizes the throughput results under various workload configurations.

\\begin{table}[H]
\\centering
\\caption{Throughput (operations/second) under different workload mixes.}
\\label{tab:throughput}
\\begin{tabular}{@{}lccc@{}}
\\toprule
\\textbf{Workload} & \\textbf{AcmeKV} & \\textbf{etcd v3.5} & \\textbf{Cassandra (QUORUM)} \\\\
\\midrule
100\\% Read          & 285,000 & 142,000 & 310,000 \\\\
100\\% Write         & 142,000 & 48,000  & 165,000 \\\\
95\\% Read / 5\\% Write  & 271,000 & 128,000 & 295,000 \\\\
50\\% Read / 50\\% Write & 198,000 & 85,000  & 225,000 \\\\
\\bottomrule
\\end{tabular}
\\end{table}

AcmeKV achieves approximately 2$\\times$ the throughput of etcd while providing the same linearizable consistency guarantees. Cassandra achieves slightly higher raw throughput, but this comes at the cost of weaker consistency (quorum reads/writes provide only regular register semantics, not linearizability).

\\section{Latency Results}

\\begin{table}[H]
\\centering
\\caption{Latency percentiles (milliseconds) for read and write operations.}
\\label{tab:latency}
\\begin{tabular}{@{}lcccc@{}}
\\toprule
\\textbf{Operation} & \\textbf{p50} & \\textbf{p90} & \\textbf{p99} & \\textbf{p99.9} \\\\
\\midrule
Read (lease-based)  & 0.8 & 1.5 & 3.2 & 8.1 \\\\
Read (consensus)    & 2.1 & 3.8 & 7.4 & 15.3 \\\\
Write               & 3.5 & 6.2 & 11.8 & 28.4 \\\\
Transaction (2-key) & 5.2 & 9.1 & 18.5 & 42.7 \\\\
\\bottomrule
\\end{tabular}
\\end{table}

% ════════════════════════════════════════════
\\chapter{Conclusion and Recommendations}
\\label{ch:conclusion}
% ════════════════════════════════════════════

\\section{Summary}

AcmeKV successfully meets all \`\`Must'' and \`\`Should'' priority requirements established in Section~1.2. The system provides linearizable consistency with production-grade performance, achieving 285K reads/sec and 142K writes/sec with sub-5ms p99 read latency on lease-based reads. Jepsen testing confirms correctness under all tested failure scenarios.

\\section{Recommendations}

Based on our evaluation, we recommend the following deployment plan:

\\begin{enumerate}[itemsep=4pt]
  \\item \\textbf{Phase 1 (Q1 2025)}: Deploy AcmeKV for configuration management and distributed locking workloads, which are currently the largest sources of consistency-related incidents.
  \\item \\textbf{Phase 2 (Q2 2025)}: Migrate the metadata catalog service to AcmeKV after completing integration testing with the data platform team.
  \\item \\textbf{Phase 3 (Q3 2025)}: Evaluate AcmeKV for financial transaction workloads, pending completion of the compliance audit and penetration testing.
\\end{enumerate}

\\section{Known Limitations}

\\begin{itemize}[itemsep=4pt]
  \\item \\textbf{Value size}: The 1MB value size limit may be insufficient for some use cases. We are investigating chunked storage for larger values.
  \\item \\textbf{Cross-DC replication}: Not yet implemented. The current system is limited to a single datacenter.
  \\item \\textbf{Range queries}: Scan performance degrades for ranges exceeding 10,000 keys due to LSM compaction overhead. We plan to implement a read cache to address this.
\\end{itemize}

\\end{document}
`,
  },
  {
    id: "book-standard",
    name: "Book",
    description: "Multi-chapter book or manuscript with front/back matter",
    category: "creative",
    subcategory: "books",
    tags: ["book", "manuscript", "chapters", "novel", "textbook", "publishing"],
    icon: "Book",
    documentClass: "book",
    mainFileName: "main.tex",
    accentColor: "#d946ef",
    hasBibliography: false,
    aspectRatio: "3/4",
    packages: [
      { name: "geometry", description: "Page layout customization" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
    ],
    content: `\\documentclass[12pt,a4paper,openany]{book}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{graphicx}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}
\\usepackage{fancyhdr}
\\usepackage{titlesec}
\\usepackage{enumitem}
\\usepackage{booktabs}
\\usepackage{microtype}
\\usepackage{xcolor}
\\usepackage{epigraph}
\\usepackage{lipsum}
\\usepackage{listings}

\\definecolor{chaptercolor}{HTML}{2C3E50}
\\definecolor{linkblue}{HTML}{2E86C1}

\\hypersetup{
  colorlinks=true,
  linkcolor=chaptercolor,
  citecolor=linkblue,
  urlcolor=linkblue
}

% Chapter heading style
\\titleformat{\\chapter}[display]
  {\\normalfont\\huge\\bfseries\\color{chaptercolor}}
  {\\fontsize{60}{60}\\selectfont\\color{chaptercolor!30}\\thechapter}
  {10pt}{\\Huge}
\\titlespacing*{\\chapter}{0pt}{-30pt}{30pt}

% Header/footer
\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[LE]{\\small\\thepage\\quad\\textit{\\nouppercase{\\leftmark}}}
\\fancyhead[RO]{\\small\\textit{\\nouppercase{\\rightmark}}\\quad\\thepage}
\\renewcommand{\\headrulewidth}{0.3pt}

% Theorem environments
\\theoremstyle{definition}
\\newtheorem{definition}{Definition}[chapter]
\\newtheorem{example}[definition]{Example}
\\theoremstyle{plain}
\\newtheorem{theorem}[definition]{Theorem}
\\newtheorem{proposition}[definition]{Proposition}

\\lstset{
  basicstyle=\\ttfamily\\small,
  keywordstyle=\\color{linkblue}\\bfseries,
  commentstyle=\\color{green!50!black}\\itshape,
  frame=single,
  breaklines=true,
  numbers=left,
  numberstyle=\\tiny\\color{gray}
}

\\begin{document}

% ──── Title Page ────
\\begin{titlepage}
\\centering
\\vspace*{3cm}
{\\color{chaptercolor}\\rule{\\textwidth}{2pt}}\\\\[1.5cm]
{\\fontsize{36}{44}\\selectfont\\bfseries\\color{chaptercolor}
  An Introduction to\\\\[0.5cm]
  Modern Cryptography}\\\\[1cm]
{\\color{chaptercolor}\\rule{0.5\\textwidth}{1pt}}\\\\[1.5cm]
{\\Large\\textit{From Classical Ciphers to Post-Quantum Security}}\\\\[2cm]
{\\LARGE\\bfseries Prof.\\\\ Daniel Hartmann}\\\\[0.3cm]
{\\large Department of Mathematics\\\\ETH Zurich}\\\\[3cm]
{\\large First Edition\\\\2025}
\\vfill
{\\small Published by Academic Press International}
\\end{titlepage}

% ──── Copyright Page ────
\\thispagestyle{empty}
\\vspace*{\\fill}
\\noindent\\textit{An Introduction to Modern Cryptography: From Classical Ciphers to Post-Quantum Security}\\\\[0.5cm]
\\noindent Copyright \\copyright\\\\ 2025 by Daniel Hartmann. All rights reserved.\\\\[0.5cm]
\\noindent Published by Academic Press International\\\\
1 University Avenue, Zurich, Switzerland\\\\[0.5cm]
\\noindent ISBN 978-0-000-00000-0 (hardcover)\\\\
ISBN 978-0-000-00000-0 (ebook)\\\\[0.5cm]
\\noindent Typeset in \\LaTeX\\\\
First printing: January 2025
\\clearpage

% ──── Front Matter ────
\\frontmatter

% Dedication
\\thispagestyle{empty}
\\vspace*{5cm}
\\begin{center}
\\textit{To my students, past and present,\\\\who remind me every day why\\\\these ideas matter.}
\\end{center}
\\clearpage

% Preface
\\chapter{Preface}

Cryptography is one of the oldest and most fascinating branches of mathematics, yet it has never been more relevant than it is today. Every time we send a message, make an online purchase, or unlock our phones, we rely on cryptographic protocols that protect our privacy and security. The mathematical foundations of these protocols are both deep and beautiful, connecting number theory, algebra, complexity theory, and more recently, quantum computing and lattice theory.

This book grew out of lecture notes for the introductory cryptography course I have taught at ETH Zurich since 2015. My goal was to write a textbook that is mathematically rigorous yet accessible to students with a solid undergraduate background in mathematics or computer science. Each chapter begins with motivation and historical context before diving into the formal treatment, and I have included numerous examples and exercises to reinforce the material.

The book is organized into three parts. Part I covers the classical foundations: historical ciphers, Shannon's information-theoretic framework, and the basic tools of modern cryptography including pseudorandom generators and hash functions. Part II treats public-key cryptography in depth, from the RSA and Diffie--Hellman systems to elliptic curve cryptography. Part III addresses the emerging challenges posed by quantum computing and introduces the lattice-based and code-based systems that are leading candidates for post-quantum cryptographic standards.

\\vspace{0.5cm}
\\noindent\\textit{Daniel Hartmann}\\\\
Zurich, January 2025

\\tableofcontents

% ──── Main Matter ────
\\mainmatter

% ════════════════════════════════════════
\\part{Classical Foundations}
% ════════════════════════════════════════

\\chapter{Historical Ciphers and the Emergence of Cryptography}

\\epigraph{\\textit{The desire to keep secrets gave rise to the art of cryptography---writing in secret code.}}{--- Simon Singh, \\textit{The Code Book}}

\\section{What Is Cryptography?}

Cryptography, from the Greek \\textit{krypt\\'{o}s} (hidden) and \\textit{gr\\'{a}phein} (to write), is the science and art of secure communication. At its core, cryptography addresses a simple yet fundamental problem: how can two parties (traditionally called Alice and Bob) communicate over an insecure channel in such a way that an eavesdropper (Eve) cannot understand their messages?

\\begin{definition}[Cryptosystem]
A \\textbf{cryptosystem} (or cipher) is a tuple $(\\mathcal{M}, \\mathcal{C}, \\mathcal{K}, E, D)$ where:
\\begin{itemize}
  \\item $\\mathcal{M}$ is the set of possible plaintexts (the message space),
  \\item $\\mathcal{C}$ is the set of possible ciphertexts,
  \\item $\\mathcal{K}$ is the set of possible keys (the key space),
  \\item $E: \\mathcal{K} \\times \\mathcal{M} \\to \\mathcal{C}$ is the encryption function,
  \\item $D: \\mathcal{K} \\times \\mathcal{C} \\to \\mathcal{M}$ is the decryption function,
\\end{itemize}
satisfying $D(k, E(k, m)) = m$ for all $k \\in \\mathcal{K}$ and $m \\in \\mathcal{M}$.
\\end{definition}

\\section{Substitution Ciphers}

The simplest and oldest class of ciphers are \\textbf{substitution ciphers}, in which each letter of the plaintext is replaced by another letter (or symbol) according to a fixed rule.

\\begin{example}[Caesar Cipher]
The Caesar cipher, attributed to Julius Caesar, shifts each letter of the alphabet by a fixed number of positions. With a shift of $k = 3$:
\\begin{center}
\\texttt{A B C D E F G H I J K L M N O P Q R S T U V W X Y Z}\\\\
\\texttt{D E F G H I J K L M N O P Q R S T U V W X Y Z A B C}
\\end{center}
Thus, the plaintext \\texttt{ATTACK AT DAWN} encrypts to \\texttt{DWWDFN DW GDZQ}.

Formally, the Caesar cipher operates on $\\mathcal{M} = \\mathcal{C} = \\mathcal{K} = \\mathbb{Z}_{26}$, with:
\\begin{align}
  E(k, m) &= (m + k) \\bmod 26 \\\\
  D(k, c) &= (c - k) \\bmod 26
\\end{align}
\\end{example}

The Caesar cipher is trivially broken by exhaustive search over the 26 possible keys. More generally, a \\textbf{monoalphabetic substitution cipher} uses an arbitrary permutation $\\sigma$ of the alphabet as the key, giving $|\\mathcal{K}| = 26! \\approx 4 \\times 10^{26}$ possible keys. Despite this enormous key space, monoalphabetic substitution ciphers are easily broken by \\textbf{frequency analysis}, a technique first described by the Arab polymath Al-Kindi in the 9th century.

\\section{The Vigen\\\`{e}re Cipher}

To resist frequency analysis, Blaise de Vigen\\\`{e}re popularized a polyalphabetic cipher in the 16th century. The Vigen\\\`{e}re cipher uses a keyword to determine a different Caesar shift for each position in the plaintext.

\\begin{definition}[Vigen\\\`{e}re Cipher]
Let $\\mathbf{k} = (k_1, k_2, \\ldots, k_d)$ be a keyword of length $d$ over $\\mathbb{Z}_{26}$. The encryption of plaintext $\\mathbf{m} = (m_1, m_2, \\ldots, m_n)$ is:
\\begin{equation}
  c_i = (m_i + k_{(i \\bmod d) + 1}) \\bmod 26
\\end{equation}
\\end{definition}

The Vigen\\\`{e}re cipher was considered \`\`unbreakable'' for nearly three centuries until Charles Babbage and Friedrich Kasiski independently discovered methods to determine the keyword length and then reduce the cipher to a collection of Caesar ciphers.

\\section{Exercises}

\\begin{enumerate}[label=\\textbf{\\thechapter.\\arabic*}]
  \\item Decrypt the following Caesar ciphertext (shift unknown):\\\\
  \\texttt{WKHUHLVQRVXFKWKLQJDVDQXQEUHDNDEOHFLSKHU}
  \\item Prove that the composition of two Caesar ciphers with keys $k_1$ and $k_2$ is equivalent to a single Caesar cipher. What is the key?
  \\item Show that the Vigen\\\`{e}re cipher is a special case of the Hill cipher.
  \\item A substitution cipher on the English alphabet maps each of the 26 letters to a unique letter. If we know that \\texttt{E} maps to \\texttt{T} and \\texttt{T} maps to \\texttt{A}, how many possible keys remain?
\\end{enumerate}

% ════════════════════════════════════════
\\chapter{Shannon's Theory of Secrecy}

\\epigraph{\\textit{The enemy knows the system.}}{--- Auguste Kerckhoffs, 1883}

\\section{Perfect Secrecy}

In his groundbreaking 1949 paper, Claude Shannon established the information-theoretic foundations of cryptography. Shannon's framework allows us to reason precisely about what it means for a cipher to be \`\`secure'' and to prove fundamental limits on what is achievable.

\\begin{definition}[Perfect Secrecy]
A cryptosystem has \\textbf{perfect secrecy} if for every plaintext distribution over $\\mathcal{M}$, every message $m \\in \\mathcal{M}$, and every ciphertext $c \\in \\mathcal{C}$ with $\\Pr[C = c] > 0$:
\\begin{equation}
  \\Pr[M = m \\mid C = c] = \\Pr[M = m]
\\end{equation}
\\end{definition}

In other words, observing the ciphertext gives the adversary \\textit{no additional information} about the plaintext beyond what was already known a priori. This is the strongest possible notion of security.

\\begin{theorem}[Shannon, 1949]
If a cryptosystem has perfect secrecy, then $|\\mathcal{K}| \\geq |\\mathcal{M}|$.
\\end{theorem}

\\begin{proof}
Suppose for contradiction that $|\\mathcal{K}| < |\\mathcal{M}|$. Fix a ciphertext $c$ with $\\Pr[C = c] > 0$. For each key $k \\in \\mathcal{K}$, there is at most one message $m = D(k, c)$. Since $|\\mathcal{K}| < |\\mathcal{M}|$, there exists a message $m^*$ such that no key decrypts $c$ to $m^*$. Therefore $\\Pr[M = m^* \\mid C = c] = 0$. If $\\Pr[M = m^*] > 0$, this violates perfect secrecy.
\\end{proof}

This theorem tells us that perfectly secret encryption is expensive: the key must be at least as long as the message. The \\textbf{one-time pad}, independently invented by Vernam (1917) and proved optimal by Shannon, achieves this bound with equality.

\\section{The One-Time Pad}

\\begin{definition}[One-Time Pad]
The one-time pad operates on binary strings: $\\mathcal{M} = \\mathcal{C} = \\mathcal{K} = \\{0, 1\\}^n$. The key $k$ is chosen uniformly at random, and:
\\begin{align}
  E(k, m) &= m \\oplus k \\\\
  D(k, c) &= c \\oplus k
\\end{align}
where $\\oplus$ denotes bitwise XOR.
\\end{definition}

\\begin{proposition}
The one-time pad has perfect secrecy.
\\end{proposition}

Despite its theoretical perfection, the one-time pad is impractical for most applications because it requires a key as long as the message and each key can be used only once. This motivates the study of \\textit{computational} security, where we relax the requirement of perfect secrecy and instead demand that no \\textit{efficient} adversary can break the system.

\\section{Exercises}

\\begin{enumerate}[label=\\textbf{\\thechapter.\\arabic*}]
  \\item Prove that the one-time pad has perfect secrecy directly from the definition.
  \\item Show that if a one-time pad key is reused for two messages, the adversary can compute $m_1 \\oplus m_2$, which often reveals both messages.
  \\item Prove that perfect secrecy implies that every key is used with equal probability for any given plaintext--ciphertext pair.
\\end{enumerate}

% ──── Back Matter ────
\\backmatter

\\chapter{Notation and Symbols}

\\begin{tabularx}{\\textwidth}{@{}lX@{}}
\\toprule
\\textbf{Symbol} & \\textbf{Meaning} \\\\
\\midrule
$\\mathcal{M}$ & Message (plaintext) space \\\\
$\\mathcal{C}$ & Ciphertext space \\\\
$\\mathcal{K}$ & Key space \\\\
$\\oplus$ & Bitwise exclusive-or (XOR) \\\\
$\\mathbb{Z}_n$ & Integers modulo $n$ \\\\
$\\mathbb{F}_q$ & Finite field with $q$ elements \\\\
$\\|x\\|$ & Euclidean norm of vector $x$ \\\\
$\\text{negl}(n)$ & Negligible function in $n$ \\\\
$\\text{poly}(n)$ & Polynomial function of $n$ \\\\
PPT & Probabilistic polynomial time \\\\
\\bottomrule
\\end{tabularx}

\\begin{thebibliography}{10}

\\bibitem{shannon1949}
C.~E. Shannon.
\\newblock Communication theory of secrecy systems.
\\newblock \\textit{Bell System Technical Journal}, 28(4):656--715, 1949.

\\bibitem{katz2020}
J.~Katz and Y.~Lindell.
\\newblock \\textit{Introduction to Modern Cryptography}.
\\newblock CRC Press, 3rd edition, 2020.

\\bibitem{goldreich2004}
O.~Goldreich.
\\newblock \\textit{Foundations of Cryptography}, volumes I--II.
\\newblock Cambridge University Press, 2001--2004.

\\bibitem{boneh2020}
D.~Boneh and V.~Shoup.
\\newblock \\textit{A Graduate Course in Applied Cryptography}.
\\newblock Draft version 0.5, 2020. Available online.

\\end{thebibliography}

\\end{document}
`,
  },
  {
    id: "newsletter",
    name: "Newsletter",
    description: "Multi-column newsletter with header and styled sections",
    category: "creative",
    subcategory: "newsletters",
    tags: ["newsletter", "column", "publication", "magazine", "bulletin"],
    icon: "Newspaper",
    documentClass: "article",
    mainFileName: "main.tex",
    accentColor: "#f97316",
    hasBibliography: false,
    aspectRatio: "3/4",
    packages: [
      { name: "geometry", description: "Page layout customization" },
      { name: "multicol", description: "Multi-column layouts" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "xcolor", description: "Color support" },
      { name: "titlesec", description: "Section title formatting" },
      { name: "fancyhdr", description: "Custom headers and footers" },
    ],
    content: `\\documentclass[10pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage[margin=0.6in]{geometry}
\\usepackage{multicol}
\\usepackage{graphicx}
\\usepackage{xcolor}
\\usepackage{titlesec}
\\usepackage{fancyhdr}
\\usepackage{tikz}
\\usepackage{enumitem}
\\usepackage{microtype}
\\usepackage{tabularx}
\\usepackage{booktabs}
\\usepackage{hyperref}

% ──── Color Theme ────
\\definecolor{primary}{HTML}{1B3A5C}
\\definecolor{accent}{HTML}{E74C3C}
\\definecolor{secondary}{HTML}{2E86C1}
\\definecolor{lightbg}{HTML}{F8F9FA}
\\definecolor{darktext}{HTML}{2C3E50}
\\definecolor{rulecolor}{HTML}{BDC3C7}

\\hypersetup{colorlinks=true,urlcolor=secondary,linkcolor=primary}

% ──── Section Styling ────
\\titleformat{\\section}{\\Large\\bfseries\\color{primary}}{}{0em}{}[{\\color{accent}\\titlerule[1.5pt]}]
\\titleformat{\\subsection}{\\large\\bfseries\\color{secondary}}{}{0em}{}
\\titlespacing{\\section}{0pt}{14pt}{6pt}
\\titlespacing{\\subsection}{0pt}{10pt}{4pt}

% ──── Header/Footer ────
\\pagestyle{fancy}
\\fancyhf{}
\\renewcommand{\\headrulewidth}{0pt}
\\fancyfoot[L]{\\small\\color{rulecolor}\\textit{CS Department Newsletter}}
\\fancyfoot[C]{\\small\\color{rulecolor}\\thepage}
\\fancyfoot[R]{\\small\\color{rulecolor}\\textit{Spring 2025}}

\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{6pt}
\\setlength{\\columnsep}{0.8cm}
\\setlength{\\columnseprule}{0.4pt}
\\renewcommand{\\columnseprulecolor}{\\color{rulecolor}}

\\begin{document}

% ════════════════════════════════════════════
% MASTHEAD
% ════════════════════════════════════════════
\\begin{tikzpicture}[remember picture, overlay]
  \\fill[primary] ([yshift=0cm]current page.north west) rectangle ([yshift=-4.5cm, xshift=\\paperwidth]current page.north west);
\\end{tikzpicture}

\\vspace*{-1.5cm}
\\begin{center}
  {\\color{white}\\fontsize{36}{44}\\selectfont\\bfseries The Computing Chronicle}\\\\[6pt]
  {\\color{white!80}\\large Department of Computer Science --- Stanford University}\\\\[4pt]
  {\\color{accent}\\rule{6cm}{2pt}}\\\\[4pt]
  {\\color{white!70}\\small Volume 12, Issue 3 \\quad|\\quad Spring 2025 \\quad|\\quad Editor: Prof.\\\\ Maria Santos}
\\end{center}

\\vspace{0.8cm}

% ════════════════════════════════════════════
% HIGHLIGHTS BAR
% ════════════════════════════════════════════
\\colorbox{lightbg}{%
\\begin{minipage}{\\dimexpr\\textwidth-2\\fboxsep}
\\centering\\small\\color{darktext}
\\textbf{IN THIS ISSUE:}\\quad
New AI Research Lab Opening $\\bullet$
Faculty Spotlight: Prof.\\\\ Kim $\\bullet$
Student Hackathon Results $\\bullet$
Alumni Interview $\\bullet$
Upcoming Events
\\end{minipage}}

\\vspace{0.6cm}

% ════════════════════════════════════════════
% MAIN CONTENT -- Two Columns
% ════════════════════════════════════════════
\\begin{multicols}{2}

% ──── Lead Story ────
\\section{Department Launches Interdisciplinary AI Research Laboratory}

The Department of Computer Science officially opened the Stanford Interdisciplinary AI Laboratory (SIAL) on March 15, with a ribbon-cutting ceremony attended by university president Dr.\\\\ Jonathan Blake and industry partners from Google, Microsoft, and NVIDIA.

The \\$45 million facility spans 25,000 square feet on the second floor of the newly renovated Gates Building and houses state-of-the-art computing infrastructure, including a cluster of 128 NVIDIA H100 GPUs and dedicated wet lab space for AI-driven biological research.

\`\`This laboratory represents our commitment to developing AI technologies that address humanity's greatest challenges,'' said department chair Prof.\\\\ Robert Chen at the opening ceremony. \`\`By bringing together researchers from computer science, medicine, climate science, and the social sciences, we aim to create AI systems that are not only powerful but also responsible and beneficial.''

\\textbf{Research Focus Areas:}
\\begin{itemize}[leftmargin=1.2em, nosep, itemsep=2pt]
  \\item \\textbf{AI for Healthcare}: Drug discovery, medical imaging, and personalized medicine
  \\item \\textbf{Climate AI}: Weather prediction, carbon capture optimization, and sustainable energy
  \\item \\textbf{Trustworthy AI}: Fairness, interpretability, robustness, and alignment
  \\item \\textbf{Foundations}: Large language models, multimodal learning, and reasoning
\\end{itemize}

The lab will host 12 faculty members, 40 graduate students, and 15 postdoctoral researchers. Industry partnerships include a \\$10 million gift from Google DeepMind and a \\$5 million equipment grant from NVIDIA.

% ──── Faculty Spotlight ────
\\section{Faculty Spotlight: Prof.\\\\ Soo-Jin Kim}

\\subsection{From Seoul to Stanford: A Journey in Computational Biology}

Prof.\\\\ Soo-Jin Kim joined the department in September 2024 after a distinguished postdoctoral fellowship at the Broad Institute of MIT and Harvard. Her research focuses on developing machine learning methods for understanding gene regulation and predicting the effects of genetic mutations on protein function.

\`\`I was drawn to computer science because of its potential to transform biology,'' Kim said in a recent interview. \`\`We are generating biological data at an unprecedented rate, and computational methods are essential for making sense of it all.''

Since arriving at Stanford, Kim has already secured a \\$1.2 million NIH R01 grant for her project on \`\`Deep Learning Models for Predicting Variant Effects in Non-Coding Regulatory Regions.'' Her group currently includes three PhD students and two postdocs.

\\textbf{Selected recent publications:}
\\begin{enumerate}[leftmargin=1.5em, nosep, itemsep=2pt]
  \\item Kim, S.-J. et al. \`\`RegulomeNet: Predicting regulatory variant effects with graph attention networks.'' \\textit{Nature Methods}, 2024.
  \\item Kim, S.-J. and Park, H. \`\`Foundation models for genomics: A survey.'' \\textit{Nature Reviews Genetics}, 2024.
\\end{enumerate}

% ──── Student News ────
\\section{Student Hackathon: Record Participation}

The 8th Annual CS Department Hackathon, held over the weekend of February 22--23, drew a record 280 participants organized into 64 teams. This year's theme, \`\`AI for Social Good,'' challenged students to build applications addressing real-world social challenges in 36 hours.

\\subsection{Winning Projects}

\\begin{description}[leftmargin=0em, style=nextline, itemsep=4pt]
  \\item[1st Place -- \`\`AccessiVision'' (Team Alpha)]
  A real-time mobile app that uses computer vision to help visually impaired users navigate indoor spaces. The app identifies obstacles, reads signs, and provides audio directions. Built with PyTorch Mobile and ARCore.

  \\item[2nd Place -- \`\`CrisisMap'' (Team Resilience)]
  A platform that aggregates social media posts during natural disasters to create real-time maps of affected areas, resource needs, and safe routes. Uses NLP to classify and geolocate posts.

  \\item[3rd Place -- \`\`FairLend'' (Team Justice)]
  An auditing tool that detects and mitigates bias in lending algorithms. Provides interpretable reports showing how different demographic groups are affected by model decisions.
\\end{description}

The winning teams received prizes including internship offers from sponsoring companies and travel grants to present at the ACM Student Research Competition.

\\columnbreak

% ──── Alumni Interview ────
\\section{Alumni Interview: Dr.\\\\ Marcus Chen (Ph.D.\\\\ '18)}

\\textit{Dr.\\\\ Marcus Chen graduated from our department in 2018 and is now VP of Engineering at Anthropic, where he leads the infrastructure team responsible for training large language models.}

\\textbf{Q: How did your time at Stanford prepare you for your current role?}

A: The rigorous theoretical foundation I received at Stanford has been invaluable. My work on distributed systems with Prof.\\\\ Ousterhout taught me how to think about large-scale infrastructure challenges. But equally important were the soft skills---collaborating with researchers from different backgrounds, communicating complex ideas clearly, and managing uncertainty.

\\textbf{Q: What advice would you give to current students?}

A: Three things. First, invest in fundamentals---algorithms, systems, and math. Trends come and go, but fundamentals are forever. Second, work on something you genuinely care about; your best work will come from intrinsic motivation. Third, build things. The gap between theory and practice is where the most interesting problems live.

\\textbf{Q: What is the most exciting development in AI right now?}

A: I am most excited about AI systems that can reason and plan, not just pattern-match. The progress in chain-of-thought reasoning and tool use suggests we are approaching systems that can genuinely assist with complex intellectual work. But we need to be thoughtful about safety and alignment---these are not afterthoughts but core engineering challenges.

% ──── Upcoming Events ────
\\section{Upcoming Events}

\\renewcommand{\\arraystretch}{1.3}
\\begin{tabularx}{\\columnwidth}{@{}lX@{}}
\\toprule
\\textbf{Date} & \\textbf{Event} \\\\
\\midrule
Apr 3 & Distinguished Lecture: Prof.\\\\ Yann LeCun, \`\`Objective-Driven AI'' \\\\
Apr 10--11 & Spring Research Symposium \\\\
Apr 15 & PhD Admissions Visit Day \\\\
Apr 22 & Industry Panel: \`\`Careers in AI'' \\\\
May 1 & Thesis proposal deadline (Fall graduates) \\\\
May 8 & Department Awards Banquet \\\\
May 15 & Senior project presentations \\\\
Jun 15 & Commencement ceremony \\\\
\\bottomrule
\\end{tabularx}

% ──── Quick Stats ────
\\section{Department by the Numbers}

\\begin{center}
\\begin{tikzpicture}[
  statbox/.style={rectangle, draw=primary, fill=lightbg, rounded corners=4pt, minimum width=3.2cm, minimum height=1.4cm, align=center}
]
  \\node[statbox] at (0,0) {{\\Large\\bfseries\\color{accent} 847}\\\\\\\\{\\tiny Undergrad majors}};
  \\node[statbox] at (3.6,0) {{\\Large\\bfseries\\color{accent} 312}\\\\\\\\{\\tiny Graduate students}};
  \\node[statbox] at (0,-1.8) {{\\Large\\bfseries\\color{accent} 68}\\\\\\\\{\\tiny Faculty members}};
  \\node[statbox] at (3.6,-1.8) {{\\Large\\bfseries\\color{accent} \\$94M}\\\\\\\\{\\tiny Research funding}};
\\end{tikzpicture}
\\end{center}

% ──── Announcements ────
\\section{Announcements}

\\begin{itemize}[leftmargin=1.2em, itemsep=4pt]
  \\item \\textbf{New course}: CS 329A \`\`Foundation Models'' will be offered for the first time in Fall 2025, co-taught by Profs.\\\\ Liang and Hashimoto.
  \\item \\textbf{Computing resources}: The department cluster has been upgraded with 64 additional A100 GPUs. Submit allocation requests via the department portal.
  \\item \\textbf{Travel grants}: Applications for the Summer Conference Travel Fund are due May 1. Awards of up to \\$2,500 are available.
  \\item \\textbf{Wellness}: The department peer counseling program holds drop-in hours every Wednesday 3--5pm in Gates 182.
\\end{itemize}

\\vspace{0.5cm}
\\begin{center}
{\\color{rulecolor}\\rule{0.8\\columnwidth}{0.5pt}}\\\\[6pt]
{\\small\\color{darktext}
\\textbf{The Computing Chronicle} is published quarterly.\\\\
Submit articles and announcements to \\href{mailto:newsletter@cs.stanford.edu}{newsletter@cs.stanford.edu}\\\\
Back issues: \\href{https://cs.stanford.edu/newsletter}{cs.stanford.edu/newsletter}}
\\end{center}

\\end{multicols}

\\end{document}
`,
  },
  {
    id: "report-scientific",
    name: "Scientific Report",
    description:
      "Professional scientific report with structured sections, statistical commands, and bibliography",
    category: "academic",
    subcategory: "reports",
    tags: [
      "scientific",
      "report",
      "research",
      "lab",
      "experiment",
      "data",
      "analysis",
      "academic",
    ],
    icon: "FlaskConical",
    documentClass: "report",
    mainFileName: "main.tex",
    accentColor: "#10b981",
    hasBibliography: true,
    aspectRatio: "3/4",
    packages: [
      { name: "amsmath", description: "AMS mathematical typesetting" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "geometry", description: "Page layout customization" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
      { name: "booktabs", description: "Professional table formatting" },
      { name: "natbib", description: "Bibliography management" },
      { name: "xcolor", description: "Color support" },
      { name: "tcolorbox", description: "Colored boxes for highlights" },
      { name: "siunitx", description: "SI units formatting" },
    ],
    content: `\\documentclass[11pt]{report}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}
\\usepackage{booktabs}
\\usepackage[numbers]{natbib}
\\usepackage{xcolor}
\\usepackage{tcolorbox}
\\usepackage{siunitx}
\\usepackage{float}

% Colors
\\definecolor{sectionblue}{HTML}{1e40af}
\\definecolor{highlightbg}{HTML}{eff6ff}
\\definecolor{notebg}{HTML}{fef3c7}

% Highlight box
\\newtcolorbox{highlight}{
  colback=highlightbg,
  colframe=sectionblue!50,
  boxrule=0.5pt,
  arc=3pt,
  left=6pt, right=6pt, top=6pt, bottom=6pt
}

% Note box
\\newtcolorbox{note}{
  colback=notebg,
  colframe=orange!50,
  boxrule=0.5pt,
  arc=3pt,
  left=6pt, right=6pt, top=6pt, bottom=6pt
}

\\hypersetup{
  colorlinks=true,
  linkcolor=sectionblue,
  citecolor=sectionblue,
  urlcolor=sectionblue
}

\\title{\\textbf{Scientific Report Title}\\\\[0.5em]
\\large Subtitle or Project Name}
\\author{Author Name\\\\
\\small Institution or Laboratory\\\\
\\small \\href{mailto:author@institution.edu}{author@institution.edu}}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Provide a concise summary of the research objectives, methodology, key findings, and conclusions. The abstract should be self-contained and typically 150--300 words.
\\end{abstract}

\\tableofcontents

\\chapter{Introduction}

Describe the background, motivation, and objectives of the study. Include relevant literature context and clearly state the research questions or hypotheses.

\\begin{highlight}
\\textbf{Research Question:} State your primary research question or hypothesis here.
\\end{highlight}

\\chapter{Materials and Methods}

\\section{Experimental Design}

Describe the overall experimental approach, including study design, variables, and controls.

\\section{Data Collection}

Detail the instruments, protocols, and procedures used for data collection.

\\section{Statistical Analysis}

All analyses were performed using standard statistical methods. Results were considered significant at $p < 0.05$.

\\begin{note}
\\textbf{Note:} Include details about software versions, packages, and specific parameters used in the analysis.
\\end{note}

\\chapter{Results}

\\section{Descriptive Statistics}

Present summary statistics and initial findings.

\\begin{table}[H]
\\centering
\\caption{Summary statistics of key variables.}
\\label{tab:summary}
\\begin{tabular}{lrrr}
\\toprule
\\textbf{Variable} & \\textbf{Mean} & \\textbf{SD} & \\textbf{N} \\\\
\\midrule
Variable A & \\num{42.5} & \\num{3.2} & 100 \\\\
Variable B & \\num{18.7} & \\num{2.1} & 100 \\\\
Variable C & \\num{7.3}  & \\num{1.8} & 100 \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\section{Main Findings}

Present the main results with appropriate figures and tables. Reference Table~\\ref{tab:summary} and any figures as needed.

\\chapter{Discussion}

Interpret the results in the context of existing literature. Discuss implications, limitations, and future directions.

\\chapter{Conclusion}

Summarize the key findings and their significance. State the main contributions of this work.

\\bibliographystyle{plainnat}
\\bibliography{references}

\\end{document}
`,
  },
  {
    id: "blank",
    name: "Blank Document",
    description: "Minimal template to start from scratch",
    category: "starter",
    subcategory: "blank",
    tags: ["blank", "empty", "minimal", "scratch", "custom"],
    icon: "File",
    documentClass: "article",
    mainFileName: "main.tex",
    accentColor: "#71717a",
    hasBibliography: false,
    aspectRatio: "3/4",
    packages: [],
    content: `\\documentclass[12pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}

\\begin{document}

% Start writing here.

\\end{document}
`,
  },
];

export const BIB_TEMPLATE = `% Add your references here
% Example:
% @article{key,
%   author  = {Author Name},
%   title   = {Article Title},
%   journal = {Journal Name},
%   year    = {2024},
% }
`;

// ─── Registry API ───

const _templates = TEMPLATES;

export function getAllTemplates(): TemplateDefinition[] {
  return _templates;
}

export function getTemplateById(id: string): TemplateDefinition | undefined {
  return _templates.find((t) => t.id === id);
}

export function getTemplatesByCategory(
  category: TemplateCategory,
): TemplateDefinition[] {
  return _templates.filter((t) => t.category === category);
}

export function getCategories(): TemplateCategory[] {
  return ["academic", "professional", "creative", "starter"];
}

export function searchTemplates(query: string): TemplateDefinition[] {
  if (!query.trim()) return _templates;
  const q = query.toLowerCase().trim();
  const words = q.split(/\s+/);
  return _templates.filter((t) => {
    const haystack = [
      t.name,
      t.description,
      t.documentClass,
      ...t.tags,
      t.category,
      t.subcategory,
    ]
      .join(" ")
      .toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

/**
 * Extract the skeleton (preamble only) from a template's content.
 * Keeps everything before \begin{document} (packages, styling, custom commands)
 * and adds an empty document body. The full `content` is preserved for
 * gallery preview / example rendering.
 */
export function getTemplateSkeleton(template: TemplateDefinition): string {
  const marker = "\\begin{document}";
  const idx = template.content.indexOf(marker);
  if (idx === -1) return template.content;

  const preamble = template.content.slice(0, idx).trimEnd();

  return `${preamble}

\\begin{document}

\\mbox{} % Placeholder — content will be generated based on your description.

\\end{document}
`;
}
