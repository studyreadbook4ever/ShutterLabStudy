#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

// All dimensions are in metres and all simulation times are in seconds.
// The GPU traces physically moving rigid geometry. A rolling shutter varies the
// observation time per sensor row; it never bends the object's geometry.
struct V3 {
    float x, y, z;
    __host__ __device__ V3(float a = 0, float b = 0, float c = 0) : x(a), y(b), z(c) {}
    __host__ __device__ V3 operator+(V3 b) const { return V3(x+b.x,y+b.y,z+b.z); }
    __host__ __device__ V3 operator-(V3 b) const { return V3(x-b.x,y-b.y,z-b.z); }
    __host__ __device__ V3 operator*(float b) const { return V3(x*b,y*b,z*b); }
    __host__ __device__ V3 operator/(float b) const { return *this*(1.0f/b); }
};
__host__ __device__ float dot(V3 a,V3 b) { return a.x*b.x+a.y*b.y+a.z*b.z; }
__host__ __device__ V3 norm(V3 a) { return a/sqrtf(fmaxf(dot(a,a),1e-20f)); }
__host__ __device__ float clampf(float x,float lo,float hi) { return fminf(hi,fmaxf(lo,x)); }
__host__ __device__ V3 mix(V3 a,V3 b,float k) { return a*(1-k)+b*k; }
__host__ __device__ float smooth(float a,float b,float v) {
    float k=clampf((v-a)/(b-a),0,1); return k*k*(3-2*k);
}

struct Params {
    int width=640,height=480;
    float theta=0.6f,omega=14,torque=0,inertia=0.5f,damping=0;
    float scan=0.035f,exposure=0.003f,fov=55,tilt=15,offset=0.45f;
    int lens=0,direction=1,samples=4,objectId=0;
};

__host__ __device__ double angleAt(const Params& p,float t) {
    double k=double(p.damping)/p.inertia;
    double acceleration=double(p.torque)/p.inertia-k*p.omega;
    if(p.damping==0) return double(p.theta)+double(p.omega)*t+0.5*acceleration*t*t;
    // The acceleration-integral form avoids subtracting nearly equal angular
    // velocities. A series also preserves the zero-damping limit exactly.
    double z=k*t;
    double secondIntegral=fabs(z)<1e-4
        ? double(t)*t*(0.5-z/6+z*z/24-z*z*z/120+z*z*z*z/720)
        : (expm1(-z)+z)/(k*k);
    return double(p.theta)+double(p.omega)*t+acceleration*secondIntegral;
}

struct Hit { float t; V3 n; float axial; int material; };
__host__ __device__ bool sphere(V3 o,V3 d,V3 c,float radius,float& nearest,V3& normal) {
    V3 oc=o-c; float b=dot(oc,d),q=dot(oc,oc)-radius*radius;
    float disc=b*b-q;
    if(disc<0) return false;
    float t=-b-sqrtf(disc);
    if(t<1e-4f) t=-b+sqrtf(disc);
    if(t<1e-4f||t>=nearest) return false;
    nearest=t; normal=norm(o+d*t-c); return true;
}

__host__ __device__ bool capsule(V3 o,V3 d,V3 c,V3 axis,float halfLength,float radius,Hit& hit) {
    V3 oc=o-c; float da=dot(d,axis),oa=dot(oc,axis);
    V3 perpendicularD=d-axis*da,perpendicularO=oc-axis*oa;
    float a=dot(perpendicularD,perpendicularD),b=dot(perpendicularD,perpendicularO);
    float q=dot(perpendicularO,perpendicularO)-radius*radius;
    bool found=false;
    float disc=b*b-a*q;
    if(a>1e-8f&&disc>=0) {
        float t=(-b-sqrtf(disc))/a;
        if(t<1e-4f) t=(-b+sqrtf(disc))/a;
        float axial=oa+t*da;
        if(t>1e-4f&&t<hit.t&&fabsf(axial)<=halfLength) {
            hit.t=t; hit.n=norm(perpendicularO+perpendicularD*t);
            hit.axial=axial; found=true;
        }
    }
    float t=hit.t; V3 n;
    if(sphere(o,d,c+axis*halfLength,radius,t,n)) {
        hit.t=t; hit.n=n; hit.axial=dot(o+d*t-c,axis); found=true;
    }
    t=hit.t;
    if(sphere(o,d,c-axis*halfLength,radius,t,n)) {
        hit.t=t; hit.n=n; hit.axial=dot(o+d*t-c,axis); found=true;
    }
    return found;
}

__host__ __device__ bool cylinder(V3 o,V3 d,V3 c,V3 axis,float radius,float halfHeight,Hit& hit) {
    V3 oc=o-c; float da=dot(d,axis),oa=dot(oc,axis);
    V3 pd=d-axis*da,po=oc-axis*oa;
    float a=dot(pd,pd),b=dot(pd,po),q=dot(po,po)-radius*radius;
    float disc=b*b-a*q; bool found=false;
    if(a>1e-8f&&disc>=0) {
        float t=(-b-sqrtf(disc))/a;
        float axial=oa+da*t;
        if(t>1e-4f&&t<hit.t&&fabsf(axial)<=halfHeight) {
            hit.t=t; hit.n=norm(po+pd*t); hit.axial=axial; found=true;
        }
    }
    if(fabsf(da)>1e-7f) {
        for(int s=-1;s<=1;s+=2) {
            float t=(s*halfHeight-oa)/da;
            V3 r=oc+d*t-axis*(s*halfHeight);
            if(t>1e-4f&&t<hit.t&&dot(r,r)<=radius*radius) {
                hit.t=t; hit.n=axis*float(s); hit.axial=s*halfHeight; found=true;
            }
        }
    }
    return found;
}

__host__ __device__ bool boundInterval(V3 o,V3 d,V3 center,float radius,float& begin,float& end) {
    V3 oc=o-center;float b=dot(oc,d),q=dot(oc,oc)-radius*radius,disc=b*b-q;
    if(disc<0) return false;
    float root=sqrtf(disc);begin=fmaxf(-b-root,1e-4f);end=-b+root;
    return end>begin;
}

// Sphere tracing uses the exact signed distance to a circular tube, bounded by
// a sphere. Unlike a screen-space ring this retains depth, lens projection,
// object-space markings, and a physically consistent rolling-shutter shadow.
__host__ __device__ bool torus(V3 o,V3 d,V3 center,V3 normal,float major,float minor,Hit& hit) {
    float begin,end;
    if(!boundInterval(o,d,center,major+minor,begin,end)||begin>=hit.t) return false;
    end=fminf(end,hit.t);
    // Every torus point lies in a thin slab around its plane. Clipping to that
    // slab skips empty sphere volume without changing the distance field.
    float originAxial=dot(o-center,normal),rayAxial=dot(d,normal);
    if(fabsf(rayAxial)>1e-7f) {
        float a=(-minor-originAxial)/rayAxial,b=(minor-originAxial)/rayAxial;
        begin=fmaxf(begin,fminf(a,b));end=fminf(end,fmaxf(a,b));
        if(begin>end) return false;
    } else if(fabsf(originAxial)>minor) return false;
    float at=begin;
    for(int step=0;step<72&&at<=end;step++) {
        V3 q=o+d*at-center;
        float axial=dot(q,normal);
        V3 planar=q-normal*axial;
        float radial=sqrtf(dot(planar,planar));
        float distance=sqrtf((radial-major)*(radial-major)+axial*axial)-minor;
        if(distance<0.00035f) {
            hit.t=at;hit.n=norm(planar*((radial-major)/fmaxf(radial,1e-8f))+normal*axial);
            hit.axial=axial;return true;
        }
        at+=fmaxf(distance,0.0001f);
    }
    return false;
}

template<int Object>
__host__ __device__ bool objectGeometry(V3 o,V3 d,V3 center,V3 u,V3 v,V3 normal,Hit& h) {
    if constexpr(Object==0) {
        if(capsule(o,d,center,u,1.60f,0.105f,h)) { h.material=1;return true; }
        return false;
    }
    float begin,end;
    if(!boundInterval(o,d,center,1.72f,begin,end)||begin>=h.t) return false;
    bool found=false;
    const float pi=3.14159265358979323846f;
    if constexpr(Object==1) {
        for(int i=0;i<3;i++) {
            float angle=i*(2*pi/3);V3 axis=u*cosf(angle)+v*sinf(angle);
            if(capsule(o,d,center+axis*0.875f,axis,0.625f,0.15f,h)) { h.material=4+i;found=true; }
        }
    } else if constexpr(Object==2) {
        for(int i=0;i<4;i++) {
            V3 axis=i<2?u:v;
            V3 outward=(i<2?v:u)*float((i%2)*2-1);
            if(capsule(o,d,center+outward*1.1f,axis,1.1f,0.10f,h)) { h.material=7+i;found=true; }
            if(capsule(o,d,center+outward*0.55f,outward,0.55f,0.027f,h)) { h.material=17;found=true; }
            V3 corner=center+u*float((i%2)*2-1)*1.1f+v*float((i/2)*2-1)*1.1f;
            float at=h.t;V3 n;
            if(sphere(o,d,corner,0.14f,at,n)) { h.t=at;h.n=n;h.axial=0;h.material=11+i;found=true; }
        }
    } else {
        if(torus(o,d,center,normal,1.60f,0.10f,h)) { h.material=15;found=true; }
        for(int i=0;i<6;i++) {
            float angle=i*(pi/3);V3 axis=u*cosf(angle)+v*sinf(angle);
            if(capsule(o,d,center+axis*0.86f,axis,0.70f,0.060f,h)) { h.material=20+i;found=true; }
        }
    }
    return found;
}

__host__ __device__ V3 ray(const Params& p,float x,float y) {
    const float pi=3.14159265358979323846f;
    float u=(2*x/p.width-1),v=(1-2*y/p.height)*float(p.height)/p.width;
    float half=p.fov*pi/360;
    if(p.lens==0) return norm(V3(u*tanf(half),v*tanf(half),-1));
    float rho=sqrtf(u*u+v*v),angle=rho*half;
    if(rho<1e-7f) return V3(0,0,-1);
    float scale=sinf(angle)/rho;
    return V3(u*scale,v*scale,-cosf(angle));
}

__host__ __device__ float periodicLine(float value,float period,float width) {
    float m=fabsf(value-period*floorf(value/period+0.5f));
    return 1-smooth(width,width*1.6f,m);
}

template<int Object>
__host__ __device__ V3 scene(const Params& p,V3 d,float angle) {
    const float pi=3.14159265358979323846f;
    V3 o(0,0,5.8f),center(p.offset,0,0);
    float tilt=p.tilt*pi/180;
    V3 axis(cosf(angle)*cosf(tilt),sinf(angle),-cosf(angle)*sinf(tilt));
    V3 side(-sinf(angle)*cosf(tilt),cosf(angle),sinf(angle)*sinf(tilt));
    V3 hubNormal(sinf(tilt),0,cosf(tilt));
    Hit h{1e20f,V3(),0,0};
    objectGeometry<Object>(o,d,center,axis,side,hubNormal,h);
    // The motor housing is fixed; its spindle passes through the moving body.
    if(cylinder(o,d,center+hubNormal*0.075f,hubNormal,0.215f,0.125f,h)) h.material=2;
    Hit core=h;
    if(cylinder(o,d,center+hubNormal*0.208f,hubNormal,0.070f,0.018f,core)) {
        h=core; h.material=3;
    }

    float backgroundT=(-2.20f-o.z)/d.z;
    if(d.z>=-1e-5f||backgroundT<=0) {
        float grad=clampf(0.5f+d.y*0.3f,0,1);
        return mix(V3(0.008f,0.015f,0.028f),V3(0.024f,0.042f,0.064f),grad);
    }
    if(h.t<backgroundT) {
        V3 pt=o+d*h.t;
        V3 light=norm(V3(-3.4f,4.4f,5.5f)-pt),view=d*(-1);
        V3 half=norm(light+view);
        float diffuse=fmaxf(dot(h.n,light),0);
        float rim=powf(1-clampf(dot(h.n,view),0,1),3);
        V3 base;
        float specular,emission=0;
        if(h.material==1) {
            base=h.axial>=0?V3(0.95f,0.245f,0.026f):V3(0.67f,0.76f,0.82f);
            // Small graduated bands rotate with the actual object.
            float tick=periodicLine(h.axial,0.40f,0.011f);
            if(fabsf(h.axial)>0.26f&&fabsf(h.axial)<1.48f) base=mix(base,V3(0.028f,0.047f,0.064f),tick*0.75f);
            if(fabsf(h.axial)>1.52f) base=mix(base,V3(0.97f,0.74f,0.42f),0.24f);
            specular=powf(fmaxf(dot(h.n,half),0),58)*0.42f;
            emission=h.axial>=0?0.065f:0.01f;
        } else if(h.material==2) {
            float radial=sqrtf(dot(pt-center-hubNormal*dot(pt-center,hubNormal),pt-center-hubNormal*dot(pt-center,hubNormal)));
            base=radial>0.175f?V3(0.24f,0.30f,0.34f):V3(0.080f,0.12f,0.15f);
            if(radial>0.145f&&radial<0.160f) base=V3(0.12f,0.53f,0.54f);
            specular=powf(fmaxf(dot(h.n,half),0),90)*0.75f;
        } else if(h.material==3) {
            base=V3(0.65f,0.74f,0.77f); specular=powf(fmaxf(dot(h.n,half),0),120)*0.8f;
        } else if(h.material==15) {
            base=V3(0.046f,0.073f,0.091f);
            if(fabsf(dot(h.n,hubNormal))>0.65f) base=V3(0.092f,0.135f,0.158f);
            V3 local=pt-center;
            float markAngle=atan2f(dot(local,side),dot(local,axis));
            if(fabsf(markAngle)<0.12f) base=V3(0.98f,0.36f,0.045f);
            specular=powf(fmaxf(dot(h.n,half),0),32)*0.30f;
        } else if(h.material==17) {
            base=V3(0.072f,0.115f,0.145f);specular=powf(fmaxf(dot(h.n,half),0),60)*0.35f;
        } else {
            bool orange=(h.material>=20?(h.material%2==0):(h.material==4||h.material==6||h.material==7||h.material==10||h.material==11));
            base=orange?V3(0.95f,0.245f,0.026f):V3(0.67f,0.76f,0.82f);
            if(h.material==6) base=V3(0.82f,0.16f,0.025f);
            if(h.material==12) base=V3(0.93f,0.65f,0.23f);
            if(h.material==13) base=V3(0.10f,0.59f,0.61f);
            if(h.material>=4&&h.material<=6&&h.axial>0.49f) base=mix(base,V3(0.055f,0.095f,0.13f),0.60f);
            if(h.material>=20&&periodicLine(h.axial,0.38f,0.009f)>0.5f) base=base*0.52f;
            if(h.material==20&&h.axial>0.54f) base=V3(0.99f,0.65f,0.14f);
            specular=powf(fmaxf(dot(h.n,half),0),58)*0.42f;emission=orange?0.045f:0.005f;
        }
        return base*(0.29f+0.74f*diffuse+emission)+V3(0.72f,0.82f,0.90f)*specular+V3(0.09f,0.16f,0.20f)*rim;
    }

    V3 pt=o+d*backgroundT;
    float radial=sqrtf(pt.x*pt.x+pt.y*pt.y);
    float illumination=0.83f+0.22f*expf(-0.07f*radial*radial);
    V3 base(0.014f,0.029f,0.047f);
    float lineWidth=0.008f;
    // The background is fixed in world coordinates and is projected by the
    // same lens as the moving object, making optical distortion observable.
    float grid=fmaxf(periodicLine(pt.x,0.5f,lineWidth),periodicLine(pt.y,0.5f,lineWidth));
    float major=fmaxf(periodicLine(pt.x,2.0f,lineWidth*1.2f),periodicLine(pt.y,2.0f,lineWidth*1.2f));
    base=mix(base,V3(0.040f,0.064f,0.080f),grid*0.72f);
    base=mix(base,V3(0.065f,0.093f,0.106f),major*0.64f);
    float axes=fmaxf(1-smooth(0.009f,0.016f,fabsf(pt.x)),1-smooth(0.009f,0.016f,fabsf(pt.y)));
    base=mix(base,V3(0.077f,0.125f,0.145f),axes*0.85f);
    float ring=1-smooth(0.008f,0.019f,fabsf(radial-1.70f));
    base=mix(base,V3(0.13f,0.22f,0.25f),ring*0.75f);
    float ringAngle=atan2f(pt.y,pt.x),tick=periodicLine(ringAngle,pi/6,0.005f);
    if(radial>1.60f&&radial<1.79f) base=mix(base,V3(0.17f,0.29f,0.32f),tick);
    // Softened shadow from three deterministic area-light samples.
    float visibility=0;
    for(int i=0;i<3;i++) {
        V3 light(-3.4f+i*0.16f,4.4f+(i%2)*0.20f,5.5f);
        V3 shadowDir=norm(light-pt); Hit shadow{sqrtf(dot(light-pt,light-pt)),V3(),0,0};
        bool blocked=objectGeometry<Object>(pt+V3(0,0,0.005f),shadowDir,center,axis,side,hubNormal,shadow);
        if(cylinder(pt+V3(0,0,0.005f),shadowDir,center+hubNormal*0.075f,hubNormal,0.215f,0.125f,shadow)) blocked=true;
        visibility+=blocked?0.0f:1.0f/3;
    }
    return base*(illumination*(0.47f+0.53f*visibility));
}

__host__ __device__ unsigned char encode(float linear) {
    float mapped=clampf(linear,0,1);
    float srgb=mapped<0.0031308f?12.92f*mapped:1.055f*powf(mapped,1/2.4f)-0.055f;
    return static_cast<unsigned char>(clampf(srgb*255+0.5f,0,255));
}

template<int Object>
__host__ __device__ uchar4 renderPixelT(const Params& p,int x,int y,bool rolling) {
    V3 total;
    float rowTime=rolling?p.direction*p.scan*((y+0.5f)/p.height-0.5f):0;
    for(int temporal=0;temporal<p.samples;temporal++) {
        float time=rowTime+p.exposure*((temporal+0.5f)/p.samples-0.5f);
        // Backward integration with strong damping can yield large finite
        // angles. Reduce in double precision before float trigonometry.
        float angle=float(remainder(angleAt(p,time),6.28318530717958647692));
        // Four rotated subpixel positions prevent aliasing on fine grid lines.
        for(int spatial=0;spatial<4;spatial++) {
            float sx=(spatial==0?0.125f:spatial==1?0.625f:spatial==2?0.375f:0.875f);
            float sy=(spatial==0?0.375f:spatial==1?0.125f:spatial==2?0.875f:0.625f);
            total=total+scene<Object>(p,ray(p,x+sx,y+sy),angle);
        }
    }
    total=total/float(4*p.samples);
    return make_uchar4(encode(total.x),encode(total.y),encode(total.z),255);
}

uchar4 renderPixel(const Params& p,int x,int y,bool rolling) {
    switch(p.objectId) {
        case 1:return renderPixelT<1>(p,x,y,rolling);
        case 2:return renderPixelT<2>(p,x,y,rolling);
        case 3:return renderPixelT<3>(p,x,y,rolling);
        default:return renderPixelT<0>(p,x,y,rolling);
    }
}

template<int Object>
__global__ void renderKernel(Params p,uchar4* output) {
    int x=blockIdx.x*blockDim.x+threadIdx.x,y=blockIdx.y*blockDim.y+threadIdx.y;
    if(x>=p.width||y>=p.height) return;
    size_t at=static_cast<size_t>(y)*p.width+x;
    output[at]=renderPixelT<Object>(p,x,y,false);
    output[at+static_cast<size_t>(p.width)*p.height]=renderPixelT<Object>(p,x,y,true);
}

void checkCuda(cudaError_t err,const char* action) {
    if(err!=cudaSuccess) throw std::runtime_error(std::string(action)+": "+cudaGetErrorString(err));
}

class Renderer {
    uchar4* device=nullptr;
    size_t capacity=0;
    cudaEvent_t start{},stop{};
public:
    Renderer() {
        checkCuda(cudaSetDevice(0),"select GPU");
        checkCuda(cudaEventCreate(&start),"create start event");
        checkCuda(cudaEventCreate(&stop),"create stop event");
    }
    ~Renderer() { if(device) cudaFree(device); cudaEventDestroy(start); cudaEventDestroy(stop); }
    float render(const Params& p,std::vector<uchar4>& pixels) {
        size_t count=static_cast<size_t>(p.width)*p.height*2;
        if(count>capacity) {
            if(device) checkCuda(cudaFree(device),"free old image");
            device=nullptr;
            checkCuda(cudaMalloc(&device,count*sizeof(uchar4)),"allocate image"); capacity=count;
        }
        pixels.resize(count);
        checkCuda(cudaEventRecord(start),"record start");
        dim3 blocks((p.width+15)/16,(p.height+15)/16),threads(16,16);
        switch(p.objectId) {
            case 1:renderKernel<1><<<blocks,threads>>>(p,device);break;
            case 2:renderKernel<2><<<blocks,threads>>>(p,device);break;
            case 3:renderKernel<3><<<blocks,threads>>>(p,device);break;
            default:renderKernel<0><<<blocks,threads>>>(p,device);break;
        }
        checkCuda(cudaGetLastError(),"launch renderer");
        checkCuda(cudaEventRecord(stop),"record stop");
        checkCuda(cudaEventSynchronize(stop),"synchronize renderer");
        float elapsed=0;
        checkCuda(cudaEventElapsedTime(&elapsed,start,stop),"measure kernel");
        checkCuda(cudaMemcpy(pixels.data(),device,count*sizeof(uchar4),cudaMemcpyDeviceToHost),"read image");
        return elapsed;
    }
};

Params parse(const std::string& line) {
    Params p; std::istringstream input(line);
    if(!(input>>p.width>>p.height>>p.theta>>p.omega>>p.torque>>p.inertia>>p.damping
              >>p.scan>>p.exposure>>p.fov>>p.lens>>p.tilt>>p.direction>>p.samples>>p.offset))
        throw std::runtime_error("request must contain 15 numeric fields and an optional object ID");
    input>>std::ws;
    if(!input.eof()&&!(input>>p.objectId)) throw std::runtime_error("invalid object ID");
    std::string extra;
    if(input>>extra) throw std::runtime_error("unexpected extra request field");
    if(p.objectId<0||p.objectId>3) throw std::runtime_error("object ID must be 0..3");
    float values[]={p.theta,p.omega,p.torque,p.inertia,p.damping,p.scan,p.exposure,p.fov,p.tilt,p.offset};
    for(float value:values) if(!std::isfinite(value)) throw std::runtime_error("non-finite request value");
    if(p.width<1||p.height<1||p.width>2048||p.height>2048||static_cast<uint64_t>(p.width)*p.height>4194304)
        throw std::runtime_error("image dimensions must be 1..2048");
    p.theta=std::remainder(p.theta,6.283185307179586f);
    p.omega=clampf(p.omega,-1e6f,1e6f); p.torque=clampf(p.torque,-100,100);
    p.inertia=clampf(p.inertia,0.02f,20); p.damping=clampf(p.damping,0,5);
    p.scan=clampf(p.scan,0,0.5f); p.exposure=clampf(p.exposure,0,0.5f);
    p.fov=clampf(p.fov,20,155); p.tilt=clampf(p.tilt,-75,75); p.offset=clampf(p.offset,-2,2);
    p.lens=p.lens==1?1:0; p.direction=p.direction<0?-1:1; p.samples=std::clamp(p.samples,1,16);
    return p;
}

double difference(const std::vector<uchar4>& a,const std::vector<uchar4>& b,size_t aStart,size_t bStart,size_t count) {
    double value=0;
    for(size_t i=0;i<count;i++) {
        const uchar4& x=a[aStart+i]; const uchar4& y=b[bStart+i];
        value+=std::abs(int(x.x)-int(y.x))+std::abs(int(x.y)-int(y.y))+std::abs(int(x.z)-int(y.z));
    }
    return value/(count*3);
}

void selfTest() {
    Renderer renderer; Params p; p.width=192;p.height=144;p.samples=6;
    std::vector<uchar4> stationary,noScan,moving,blurred,fish,reference;
    size_t panel=static_cast<size_t>(p.width)*p.height;
    p.omega=0; renderer.render(p,stationary);
    double stationaryDelta=difference(stationary,stationary,0,panel,panel);
    p.omega=18; p.scan=0; renderer.render(p,noScan);
    double zeroScanDelta=difference(noScan,noScan,0,panel,panel);
    p.scan=0.070f; p.exposure=0; float kernelMs=renderer.render(p,moving);
    double motionDelta=difference(moving,moving,0,panel,panel);
    p.exposure=0.045f; renderer.render(p,blurred);
    double exposureDelta=difference(moving,blurred,0,0,panel);
    p.lens=1; renderer.render(p,fish);
    double lensDelta=difference(blurred,fish,0,0,panel);
    int cpuMaxError=0;
    for(int y=7;y<p.height;y+=19) for(int x=3;x<p.width;x+=23) {
        uchar4 cpu=renderPixel(p,x,y,true),gpu=fish[panel+y*p.width+x];
        cpuMaxError=std::max(cpuMaxError,std::abs(int(cpu.x)-int(gpu.x)));
        cpuMaxError=std::max(cpuMaxError,std::abs(int(cpu.y)-int(gpu.y)));
        cpuMaxError=std::max(cpuMaxError,std::abs(int(cpu.z)-int(gpu.z)));
    }
    Params analytic; analytic.theta=0.25f;analytic.omega=2;analytic.torque=3;analytic.inertia=0.5f;
    float accelerationError=fabsf(angleAt(analytic,0.2f)-0.77f);
    analytic.damping=0.4f;
    double t=0.13,k=analytic.damping/analytic.inertia,terminal=analytic.torque/analytic.damping;
    double expected=analytic.theta+terminal*t+(analytic.omega-terminal)*(1-std::exp(-k*t))/k;
    double dampingError=std::abs(angleAt(analytic,float(t))-expected);
    analytic.damping=1e-8f;
    double smallDampingError=std::abs(angleAt(analytic,0.2f)-0.77);
    Params extreme;
    extreme.inertia=0.02f;extreme.damping=5;extreme.omega=250;extreme.torque=100;
    bool extremeTrajectoryFinite=std::isfinite(angleAt(extreme,-0.5f));
    Params highSpeed=parse("64 64 0 1000000 0 0.5 0 0.04 0.001 65 0 15 1 8 0.45");
    bool highSpeedUncapped=highSpeed.omega==1e6f&&std::isfinite(angleAt(highSpeed,0.5f));
    // A reversed readout must match a forward readout with reversed angular
    // velocity when there is no torque, damping, or finite exposure.
    p.lens=0;p.exposure=0;p.direction=-1;renderer.render(p,reference);
    p.omega=-p.omega;p.direction=1;renderer.render(p,fish);
    double directionDelta=difference(reference,fish,panel,panel,panel);
    bool objectsPassed=true;
    std::ostringstream objectResults;
    std::vector<uchar4> rodBaseline;
    for(int id=0;id<4;id++) {
        Params object;object.width=p.width;object.height=p.height;object.samples=4;object.objectId=id;
        object.omega=0;renderer.render(object,stationary);
        double staticError=difference(stationary,stationary,0,panel,panel);
        if(id==0) rodBaseline=stationary;
        double unique=difference(stationary,rodBaseline,0,0,panel);
        object.omega=18;object.scan=0;renderer.render(object,noScan);
        double scanError=difference(noScan,noScan,0,panel,panel);
        object.scan=0.070f;float objectMs=renderer.render(object,moving);
        double movingDifference=difference(moving,moving,0,panel,panel);
        int maxError=0;
        for(int y=9;y<object.height;y+=31) for(int x=7;x<object.width;x+=29) {
            uchar4 cpu=renderPixel(object,x,y,true),gpu=moving[panel+y*object.width+x];
            maxError=std::max(maxError,std::abs(int(cpu.x)-int(gpu.x)));
            maxError=std::max(maxError,std::abs(int(cpu.y)-int(gpu.y)));
            maxError=std::max(maxError,std::abs(int(cpu.z)-int(gpu.z)));
        }
        objectsPassed=objectsPassed&&staticError==0&&scanError==0&&movingDifference>0.35
                     &&(id==0||unique>0.5)&&maxError<=4;
        if(id>0) objectResults<<',';
        objectResults<<"{\"id\":"<<id<<",\"stationaryError\":"<<staticError
                     <<",\"zeroScanError\":"<<scanError<<",\"rollingDifference\":"<<movingDifference
                     <<",\"rodDifference\":"<<unique<<",\"cpuGpuMaxError\":"<<maxError
                     <<",\"kernelMs\":"<<objectMs<<'}';
    }
    bool optionalObjectCompatible=parse("64 64 0 1 0 0.5 0 .02 .001 65 0 15 1 8 .45").objectId==0
        &&parse("64 64 0 1 0 0.5 0 .02 .001 65 0 15 1 8 .45 3").objectId==3;
    bool passed=stationaryDelta==0&&zeroScanDelta==0&&motionDelta>0.5&&exposureDelta>0.3&&lensDelta>0.3
                &&cpuMaxError<=3&&accelerationError<1e-5&&dampingError<1e-5&&directionDelta==0
                &&smallDampingError<1e-6&&extremeTrajectoryFinite&&highSpeedUncapped
                &&objectsPassed&&optionalObjectCompatible;
    std::cout<<std::setprecision(8)<<"{\"passed\":"<<(passed?"true":"false")
             <<",\"stationaryPanelMeanError\":"<<stationaryDelta
             <<",\"zeroScanPanelMeanError\":"<<zeroScanDelta
             <<",\"rollingMeanDifference\":"<<motionDelta
             <<",\"exposureMeanDifference\":"<<exposureDelta
             <<",\"lensMeanDifference\":"<<lensDelta
             <<",\"cpuGpuMaxChannelError\":"<<cpuMaxError
             <<",\"constantTorqueAngleError\":"<<accelerationError
             <<",\"dampedAngleError\":"<<dampingError
             <<",\"smallDampingLimitError\":"<<smallDampingError
             <<",\"extremeTrajectoryFinite\":"<<(extremeTrajectoryFinite?"true":"false")
             <<",\"highSpeedUncapped\":"<<(highSpeedUncapped?"true":"false")
             <<",\"reversedScanMeanError\":"<<directionDelta
             <<",\"optionalObjectCompatible\":"<<(optionalObjectCompatible?"true":"false")
             <<",\"objects\":["<<objectResults.str()<<']'
             <<",\"kernelMs\":"<<kernelMs<<"}\n";
    if(!passed) throw std::runtime_error("renderer self-test failed");
}

int main(int argc,char** argv) {
    try {
        if(argc==2&&std::string(argv[1])=="--info") {
            cudaDeviceProp prop{}; checkCuda(cudaGetDeviceProperties(&prop,0),"query GPU");
            int runtime=0,driver=0;
            checkCuda(cudaRuntimeGetVersion(&runtime),"query runtime");
            checkCuda(cudaDriverGetVersion(&driver),"query driver");
            std::cout<<"{\"backend\":\"CUDA\",\"backendId\":1,\"gpu\":\""<<prop.name
                     <<"\",\"computeCapability\":\""<<prop.major<<'.'<<prop.minor
                     <<"\",\"runtimeVersion\":"<<runtime<<",\"driverVersion\":"<<driver
                     <<",\"temporalSamplesMax\":16,\"spatialSamples\":4,\"protocolVersion\":1"
                     <<",\"supportedObjects\":[{\"id\":0,\"key\":\"rod\"},{\"id\":1,\"key\":\"propeller\"},"
                     <<"{\"id\":2,\"key\":\"square\"},{\"id\":3,\"key\":\"wheel\"}]}\n";
            return 0;
        }
        if(argc==2&&std::string(argv[1])=="--self-test") { selfTest();return 0; }
        if(argc!=1) throw std::runtime_error("usage: shutter-renderer [--info | --self-test]");
        Renderer renderer; std::vector<uchar4> pixels; std::string line;
        while(std::getline(std::cin,line)) {
            if(line.empty()) continue;
            Params p=parse(line);
            float elapsed=renderer.render(p,pixels);
            // This wire format is exactly 16 bytes followed by two RGBA images.
            uint32_t magic=0x53485554,payload=uint32_t(pixels.size()*sizeof(uchar4)),backend=1;
            static_assert(sizeof(float)==4&&sizeof(uint32_t)==4&&sizeof(uchar4)==4,"wire sizes");
            std::cout.write(reinterpret_cast<const char*>(&magic),4);
            std::cout.write(reinterpret_cast<const char*>(&payload),4);
            std::cout.write(reinterpret_cast<const char*>(&elapsed),4);
            std::cout.write(reinterpret_cast<const char*>(&backend),4);
            std::cout.write(reinterpret_cast<const char*>(pixels.data()),payload);
            std::cout.flush();
            if(!std::cout) throw std::runtime_error("write response failed");
        }
        return 0;
    } catch(const std::exception& e) { std::cerr<<"shutter-renderer: "<<e.what()<<'\n';return 1; }
}
